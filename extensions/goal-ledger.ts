import { goalStoragePath, ensureGoalStorageDirectory, isExternalGoalStorage, type GoalStorageContext } from "./storage/goal-root.ts";
import { indexedActivityEvents } from "./goal-activity.ts";
import { buildLedgerIndex, indexLedgerEvent, auditApplies, type GoalLedgerIndex } from "./goal-ledger-index.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "./storage/atomic-rename.ts";
import { nowIso, safeIdPart, type GoalRecord } from "./goal-record.ts";

export const GOAL_LEDGER_FILE = ".pi/goals/goal_events.jsonl";

export type GoalLedgerEvent =
  | { type: "goal_created"; goalId: string; objective: string; sisyphus: boolean; autoContinue: boolean; at: string }
  | { type: "goal_focused"; goalId: string; reason: string; at: string }
  | { type: "goal_unfocused"; reason: string; at: string }
  | { type: "goal_paused"; goalId: string; reason: string; suggestedAction?: string; status?: "paused"; source?: "user" | "agent"; at: string }
  | { type: "goal_resumed"; goalId: string; reason: string; at: string }
  | { type: "goal_tweaked"; goalId: string; changeSummary: string; at: string }
  | { type: "auditor_toggled"; goalId: string; enabled: boolean; at: string }
  | { type: "completion_requested"; goalId: string; summary?: string; at: string }
  | { type: "audit_started"; goalId: string; auditId?: string; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "audit_result"; goalId: string; auditId?: string; verdict: "approved" | "disapproved" | "error"; report: string; at: string }
  | { type: "audit_skipped"; goalId: string; auditId?: string; reason: "disabled" | "user_aborted"; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "goal_completed"; goalId: string; archivePath?: string; at: string }
  | { type: "goal_archived"; goalId: string; archivePath: string; at: string }
  | { type: "goal_archive_failed"; goalId: string; message: string; at: string }
  | { type: "goal_aborted"; goalId: string; reason: string; archivePath?: string; at: string }
  | { type: "task_list_set"; goalId: string; taskCount: number; blockCompletion: boolean; at: string }
  | { type: "task_complete"; goalId: string; taskId: string; evidence?: string; at: string }
  | { type: "task_skipped"; goalId: string; taskId: string; reason: string; at: string }
  | { type: "task_reopened"; goalId: string; taskId: string; at: string }
  | { type: "task_started"; goalId: string; taskId: string; at: string }
  | { type: "goal_budget_changed"; goalId: string; oldBudget: number | null; newBudget: number | null; tokensUsed: number; at: string }
  | { type: "goal_budget_limited"; goalId: string; budget: number; tokensUsed: number; at: string }
  | { type: "goal_budget_warning"; goalId: string; budget: number; tokensUsed: number; pct: number; at: string }
  | { type: "goal_stalled"; goalId: string; reason: string; at: string }
  | { type: "goal_blocked"; goalId: string; reason: string; source: "agent" | "system"; at: string }
  | { type: "oracle_started"; goalId: string; fingerprint: string; provider: string; model: string; thinkingLevel?: string; reason: string; at: string }
  | { type: "oracle_result"; goalId: string; fingerprint: string; adviceId: string; disposition: "actionable" | "needs_human" | "insufficient_context"; summary: string; recommendedTitle?: string; at: string }
  | { type: "oracle_failed"; goalId: string; fingerprint: string; attempt: number; errorCode: "config" | "provider" | "aborted" | "invalid_output"; message: string; at: string }
  | { type: "oracle_followup_attempted"; goalId: string; fingerprint: string; adviceId: string; firstToolName: string; at: string };

export type GoalLedgerContext = GoalStorageContext;

export interface GoalLedgerReadResult {
  events: GoalLedgerEvent[];
  malformed: number;
  /** Opaque generation for borrowed, read-only history views; replaced on append/refresh. */
  revision?: object;
}

export interface ReconstructedGoalState {
  goalId: string;
  latestStatus: "active" | "paused" | "complete" | "aborted" | "unknown";
  latestFocus: boolean;
  latestPauseReason?: string;
  latestPauseSuggestedAction?: string;
  latestAuditId?: string;
  latestAuditorResult?: { verdict: "approved" | "disapproved" | "error"; report: string; at: string };
  /** Issue #26: bounded latest Oracle disposition for this goal. */
  latestOracleResult?: { fingerprint: string; adviceId: string; disposition: "actionable" | "needs_human" | "insufficient_context"; summary: string; at: string };
  createdAt?: string;
  completedAt?: string;
  abortedAt?: string;
  tweakedAt?: string;
  resumedAt?: string;
}

export interface ReconstructedLedgerState {
  focusedGoalId: string | null;
  goals: Map<string, ReconstructedGoalState>;
  terminalGoals: Map<string, ReconstructedGoalState>;
}

function safeGoalId(value: string): string {
  return safeIdPart(value);
}

export function goalLedgerPath(ctx: GoalLedgerContext): string {
  return goalStoragePath(ctx, GOAL_LEDGER_FILE);
}

export type GoalLedgerAppendResult = { ok: true } | { ok: false; error: unknown };

/**
 * Append one ledger event. Returns a discriminated result instead of swallowing
 * both append attempts internally: the authoritative state write is never
 * rolled back after a ledger failure, but callers (GoalService) route failures
 * through the onDiagnostic hook so they stay observable.
 *
 * NAF: after a successful append the in-memory ledger cache is extended with
 * the same event (sanitized), so the next readGoalLedger is zero-op and
 * always current for extension-mediated writes.
 */
export function appendGoalEvent(ctx: GoalLedgerContext, event: GoalLedgerEvent): GoalLedgerAppendResult {
  const result = appendLedgerLines(ctx, [event]);
  return result;
}

/**
 * Append several ledger events as one line block with the existing
 * temp-write→read→append durability (P1-8): one mkdir, one temp write, one
 * append, one unlink instead of N× the same sequence. NAF: extends the
 * in-memory ledger cache in one step too.
 */
export function appendGoalEvents(ctx: GoalLedgerContext, events: GoalLedgerEvent[]): GoalLedgerAppendResult {
  if (events.length === 0) return { ok: true };
  return appendLedgerLines(ctx, events);
}

function appendLedgerLines(ctx: GoalLedgerContext, events: GoalLedgerEvent[]): GoalLedgerAppendResult {
  const filePath = goalLedgerPath(ctx);
  const dir = path.dirname(filePath);
  // NAF: per-dir memo — mkdir once per directory per process; steady-state
  // appends skip it entirely (0 ops for the dir).
  if (!ledgerDirsKnown.has(dir)) {
    try {
      ensureGoalStorageDirectory(ctx, ".pi/goals", false);
      ledgerDirsKnown.add(dir);
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  const lines = events.map((event) => JSON.stringify(event) + "\n").join("");
  // NAF: direct O_APPEND write (one op) instead of the temp-write→read→append
  // dance — a single JSONL line (or one batched block) is appended atomically
  // by the OS; torn-line handling lives in the reader, not here.
  try {
    if (isExternalGoalStorage(ctx)) {
      ensureGoalStorageDirectory(ctx, ".pi/goals");
      try { if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Goal ledger is a symlink: ${filePath}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    fs.appendFileSync(filePath, lines, "utf8");
  } catch (err) {
    return { ok: false, error: err };
  }
  extendLedgerCache(filePath, lines, events);
  // Best-effort checkpoint maintenance: bounded cold starts depend on it, but
  // the ledger append above is authoritative and never rolled back.
  updateLedgerCheckpointAfterAppend(filePath, lines, events);
  return { ok: true };
}

/** Directories whose ledger file exists (per-dir mkdir memo). */
const ledgerDirsKnown = new Set<string>();

/**
 * Zero-op ledger cache (NAF 2026-08-06): keyed by absolute ledger path.
 * Steady-state reads serve the cache with no fs ops; appendGoalEvent(s)
 * extend it in memory (see extendLedgerCache). External (non-extension)
 * edits to the ledger go stale mid-session (documented in the naf spec).
 */
interface LedgerCacheEntry {
  size: number;
  mtimeMs: number;
  chars: number;
  events: GoalLedgerEvent[];
  malformed: number;
  revision: object;
}

const ledgerCache = new Map<string, LedgerCacheEntry>();

/**
 * Session boundary (session_start / resume): drop the zero-op ledger cache and
 * the checkpoint mirror so a new session re-reads the ledger fresh from disk.
 */
export function invalidateGoalLedgerCache(): void {
	ledgerCache.clear();
 runtimeReady.clear();
	checkpointCache.clear();
	lastCheckpointDiskWrite.clear();
}

/** Keep the zero-op ledger cache in sync with an in-process append (no fs ops). */
function extendLedgerCache(filePath: string, lines: string, events: GoalLedgerEvent[]): void {
  const cached = ledgerCache.get(filePath);
  if (!cached) return;
  for (const event of events) cached.events.push(sanitizeEvent(event));
  ledgerCache.set(filePath, {
    size: cached.size + Buffer.byteLength(lines, "utf8"),
    mtimeMs: cached.mtimeMs,
    chars: cached.chars + lines.length,
    events: cached.events,
    malformed: cached.malformed,
    revision: {},
  });
}

export function readGoalLedger(ctx: GoalLedgerContext): GoalLedgerReadResult {
  const filePath = goalLedgerPath(ctx);
  const cached = ledgerCache.get(filePath);
  if (cached) {
    // NAF zero-op steady state: no stat, no read, no parse. The cache is kept
    // current by extendLedgerCache on every in-process append; external
    // (non-extension) edits to the ledger go stale mid-session (documented).
    return { events: cached.events, malformed: cached.malformed, revision: cached.revision };
  }
  return readGoalLedgerCold(ctx, filePath);
}

/** Cold read: full file read + parse, populating the zero-op cache. */
function readGoalLedgerCold(ctx: GoalLedgerContext, filePath: string): GoalLedgerReadResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    // Missing or unreadable: cache the empty result so repeated reads are zero-op.
    const empty = {events: [], malformed: 0, revision: {}};
    ledgerCache.set(filePath, {size: 0, mtimeMs: 0, chars: 0, ...empty});
    return empty;
  }
  const parsed = parseLedgerLines(content);
  const result = {...parsed, revision: {}};
  ledgerCache.set(filePath, { size: Buffer.byteLength(content, "utf8"), mtimeMs: 0, chars: content.length, ...result });
  return result;
}

/** Parse a JSONL ledger body into sanitized events + a malformed-line count. */
function parseLedgerLines(content: string): GoalLedgerReadResult {
  const events: GoalLedgerEvent[] = [];
  // Goal IDs repeat across most rows. A bounded per-read map avoids repeated sanitation.
  const goalIds = new Map<string, string>();
  let malformed = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isValidLedgerEvent(parsed)) {
        if ("goalId" in parsed) {
          let id = goalIds.get(parsed.goalId);
          if (id === undefined) { id = safeGoalId(parsed.goalId); if (goalIds.size < 1024) goalIds.set(parsed.goalId, id); }
          parsed.goalId = id;
        }
        events.push(parsed);
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

// ---------------------------------------------------------------------------
// Ledger checkpoint (reliability campaign 2026-08-09)
//
// The zero-op cache bounds steady-state reads, but a fresh session still reads
// and parses the complete JSONL ledger. The checkpoint bounds the COLD path:
// it stores the reconstructed accumulator (state + focus bookkeeping), the
// per-goal recent-event tails, and the byte position of the ledger it covers.
// A cold read then costs 2 fs ops (checkpoint read + stat) when covered, or a
// bounded positioned tail read when the ledger grew. The JSONL ledger itself
// is untouched and remains authoritative: the checkpoint is a best-effort
// optimization — missing/corrupt/version-mismatched checkpoints fall back to
// the full parse, and any coveredBytes mismatch (external edits, truncation)
// falls back or replays the tail.
// ---------------------------------------------------------------------------

export const LEDGER_CHECKPOINT_FILE = ".goal-ledger-checkpoint.json";
export const LEDGER_CHECKPOINT_VERSION = 4;
const CHECKPOINT_RECENT_CAP = 12;

/** In-memory ledger checkpoint (maps in native form). */
export interface LedgerCheckpoint {
  version: typeof LEDGER_CHECKPOINT_VERSION;
  format: "goal-ledger-checkpoint";
  createdAt: string;
  /** Byte length of the ledger covered (compared against stat().size). */
  coveredBytes: number;
  /** Number of ledger events covered. */
  coveredEvents: number;
  /** Pre-finalize accumulator (focus bookkeeping kept for incremental tail apply). */
  acc: ReconstructAccumulator;
  /** Per-goal recent-event tails (capped), already sanitized. */
  recentEventsByGoal: Map<string, GoalLedgerEvent[]>;
  runtimeIndex: Map<string, GoalLedgerIndex>;
}

export interface LedgerStateReadResult {
  state: ReconstructedLedgerState;
  recentEventsByGoal: Map<string, GoalLedgerEvent[]>;
  malformed: number;
  coveredBytes: number;
  coveredEvents: number;
  source: "cache" | "checkpoint" | "tail" | "full";
}

/** In-process checkpoint mirror (null = known absent). */
const checkpointCache = new Map<string, LedgerCheckpoint | null>();

/**
 * Disk-write throttle for the mutation path: the in-memory mirror updates on
 * every append (0 fs ops), but the atomic temp-write+rename lands at most once
 * per CHECKPOINT_WRITE_INTERVAL appends or CHECKPOINT_WRITE_MIN_MS elapsed —
 * keeping the NAF append headroom (B1.append.x4 <= 2 ops) while still bounding
 * cold-start tails for long sessions. Staleness is always safe: a coveredBytes
 * mismatch only costs a tail replay.
 */
const CHECKPOINT_WRITE_INTERVAL = 32;
const CHECKPOINT_WRITE_MIN_MS = 2000;
const lastCheckpointDiskWrite = new Map<string, { appendsSinceWrite: number; at: number }>();

function goalIdOf(event: GoalLedgerEvent): string | null {
  return "goalId" in event ? event.goalId : null;
}

function checkpointPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), LEDGER_CHECKPOINT_FILE);
}

/** JSON-safe checkpoint shape (Maps serialized as arrays). */
function checkpointToJson(cp: LedgerCheckpoint): unknown {
  const goalStateToJson = (s: ReconstructedGoalState) => ({
    goalId: s.goalId,
    latestStatus: s.latestStatus,
    latestFocus: s.latestFocus,
    latestPauseReason: s.latestPauseReason,
    latestPauseSuggestedAction: s.latestPauseSuggestedAction,
    latestAuditorResult: s.latestAuditorResult,
    latestAuditId: s.latestAuditId,
    latestOracleResult: s.latestOracleResult,
    createdAt: s.createdAt,
    completedAt: s.completedAt,
    abortedAt: s.abortedAt,
    tweakedAt: s.tweakedAt,
    resumedAt: s.resumedAt,
  });
  const mapToJson = (m: Map<string, ReconstructedGoalState>) => Array.from(m.values()).map(goalStateToJson);
  return {
    version: cp.version,
    format: cp.format,
    createdAt: cp.createdAt,
    coveredBytes: cp.coveredBytes,
    coveredEvents: cp.coveredEvents,
    acc: {
      goals: mapToJson(cp.acc.goals),
      terminalGoals: mapToJson(cp.acc.terminalGoals),
      focusedGoalId: cp.acc.focusedGoalId,
      focusGeneration: cp.acc.focusGeneration,
      focusGenByGoal: Array.from(cp.acc.focusGenByGoal.entries()),
    },
    recentEventsByGoal: Array.from(cp.recentEventsByGoal.entries()),
    runtimeIndex: Array.from(cp.runtimeIndex, ([id, entry]) => [id, { ...entry, oracle: Array.from(entry.oracle) }]),
  };
}

function parseGoalState(value: unknown): ReconstructedGoalState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.goalId !== "string") return null;
  const latestStatus = o.latestStatus;
  if (latestStatus !== "active" && latestStatus !== "paused" && latestStatus !== "complete" && latestStatus !== "aborted" && latestStatus !== "unknown") return null;
  const auditor = o.latestAuditorResult as Record<string, unknown> | undefined;
  if (auditor !== undefined) {
    if (auditor.verdict !== "approved" && auditor.verdict !== "disapproved" && auditor.verdict !== "error") return null;
    if (typeof auditor.report !== "string" || typeof auditor.at !== "string") return null;
  }
  const oracle = o.latestOracleResult as Record<string, unknown> | undefined;
  if (oracle !== undefined && (!oracle || typeof oracle.fingerprint !== "string" || typeof oracle.adviceId !== "string" || typeof oracle.summary !== "string" || typeof oracle.at !== "string"
   || !["actionable", "needs_human", "insufficient_context"].includes(oracle.disposition as string))) return null;
  return {
    goalId: o.goalId,
    latestStatus,
    latestFocus: o.latestFocus === true,
    latestAuditId: typeof o.latestAuditId === "string" ? o.latestAuditId : undefined,
    latestOracleResult: oracle as ReconstructedGoalState["latestOracleResult"],
    latestPauseReason: typeof o.latestPauseReason === "string" ? o.latestPauseReason : undefined,
    latestPauseSuggestedAction: typeof o.latestPauseSuggestedAction === "string" ? o.latestPauseSuggestedAction : undefined,
    latestAuditorResult: auditor
      ? { verdict: auditor.verdict as "approved" | "disapproved" | "error", report: auditor.report as string, at: auditor.at as string }
      : undefined,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : undefined,
    completedAt: typeof o.completedAt === "string" ? o.completedAt : undefined,
    abortedAt: typeof o.abortedAt === "string" ? o.abortedAt : undefined,
    tweakedAt: typeof o.tweakedAt === "string" ? o.tweakedAt : undefined,
    resumedAt: typeof o.resumedAt === "string" ? o.resumedAt : undefined,
  };
}

/** Parse + validate a checkpoint file body; null on any mismatch (version/format/shape). */
function checkpointFromJson(value: unknown): LedgerCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (o.version !== LEDGER_CHECKPOINT_VERSION) return null;
  if (o.format !== "goal-ledger-checkpoint") return null;
  if (typeof o.coveredBytes !== "number" || !Number.isSafeInteger(o.coveredBytes) || o.coveredBytes < 0) return null;
  if (typeof o.coveredEvents !== "number" || !Number.isSafeInteger(o.coveredEvents) || o.coveredEvents < 0) return null;
  const accRaw = o.acc as Record<string, unknown> | undefined;
  if (!accRaw || typeof accRaw.focusGeneration !== "number" || !Number.isSafeInteger(accRaw.focusGeneration) || !Array.isArray(accRaw.goals) || !Array.isArray(accRaw.terminalGoals) || !Array.isArray(accRaw.focusGenByGoal) || !Array.isArray(o.recentEventsByGoal)) return null;
  const goals = new Map<string, ReconstructedGoalState>();
  for (const raw of Array.isArray(accRaw.goals) ? accRaw.goals : []) {
    const s = parseGoalState(raw);
    if (!s) return null;
    goals.set(s.goalId, s);
  }
  const terminalGoals = new Map<string, ReconstructedGoalState>();
  for (const raw of Array.isArray(accRaw.terminalGoals) ? accRaw.terminalGoals : []) {
    const s = parseGoalState(raw);
    if (!s) return null;
    terminalGoals.set(s.goalId, s);
  }
  const focusGenByGoal = new Map<string, number>();
  for (const [gid, gen] of Array.isArray(accRaw.focusGenByGoal) ? accRaw.focusGenByGoal : []) {
    if (typeof gid === "string" && typeof gen === "number") focusGenByGoal.set(gid, gen);
  }
  const recentEventsByGoal = new Map<string, GoalLedgerEvent[]>();
  for (const [gid, evs] of Array.isArray(o.recentEventsByGoal) ? o.recentEventsByGoal : []) {
    if (typeof gid !== "string" || !Array.isArray(evs)) continue;
    const clean: GoalLedgerEvent[] = [];
    for (const ev of evs) {
      if (isValidLedgerEvent(ev)) clean.push(sanitizeEvent(ev));
    }
    if (clean.length > 0) recentEventsByGoal.set(gid, clean);
  }
  if (!Array.isArray(o.runtimeIndex)) return null;
  const runtimeIndex = new Map<string, GoalLedgerIndex>();
  for (const pair of o.runtimeIndex) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") return null;
    const entry = pair[1];
    if (!entry || !Array.isArray(entry.recent) || !Array.isArray(entry.activity) || !Array.isArray(entry.oracle)) return null;
    if (entry.recent.length > 12 || entry.activity.length > 64) return null;
    if (entry.activity.length > 0 && !entry.lastActivityEvent) return null;
    if (![...entry.recent, ...entry.activity, ...[entry.audit, entry.auditStarted, entry.settledAudit, entry.completion, entry.lifecycle, entry.lastActivityEvent].filter(Boolean)].every(isValidLedgerEvent)) return null;
    if (!entry.oracle.every((p: unknown[]) => {
     if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || !p[1] || typeof p[1] !== "object") return false;
     const state = p[1] as Record<string, unknown>;
     if (!Number.isSafeInteger(state.failedAttempts) || (state.failedAttempts as number) < 0 || typeof state.followupAttempted !== "boolean") return false;
     const result = state.result as Record<string, unknown> | undefined;
     if (result !== undefined && (!result || typeof result.adviceId !== "string" || typeof result.summary !== "string" || !["actionable", "needs_human", "insufficient_context"].includes(result.disposition as string))) return false;
     const failure = state.lastFailure as Record<string, unknown> | undefined;
     return failure === undefined || Boolean(failure && typeof failure.errorCode === "string" && typeof failure.message === "string");
    })) return null;
    runtimeIndex.set(pair[0], { ...entry, oracle: new Map(entry.oracle) });
  }
  return {
    runtimeIndex,
    version: LEDGER_CHECKPOINT_VERSION,
    format: "goal-ledger-checkpoint",
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
    coveredBytes: o.coveredBytes,
    coveredEvents: o.coveredEvents,
    acc: {
      goals,
      terminalGoals,
      focusedGoalId: typeof accRaw.focusedGoalId === "string" ? accRaw.focusedGoalId : null,
      focusGeneration: accRaw.focusGeneration,
      focusGenByGoal,
    },
    recentEventsByGoal,
  };
}

/** Atomic checkpoint write: temp file + rename in the ledger directory. Best-effort. */
function writeLedgerCheckpointAtomic(filePath: string, cp: LedgerCheckpoint): void {
  try {
    writeFileAtomicSync(checkpointPathFor(filePath), JSON.stringify(checkpointToJson(cp)));
  } catch (err) {
    // The checkpoint is an optimization; a failed write only costs a full
    // parse on the next cold read.
    console.error("[goal-ledger] checkpoint write failed:", err);
  }
}

/** Read + validate the checkpoint for a ledger path (cached per process). */
function readLedgerCheckpointFile(filePath: string): LedgerCheckpoint | null {
  const cached = checkpointCache.get(filePath);
  if (cached !== undefined) return cached;
  let cp: LedgerCheckpoint | null = null;
  try {
    const raw = fs.readFileSync(checkpointPathFor(filePath), "utf8");
    cp = checkpointFromJson(JSON.parse(raw));
  } catch {
    cp = null;
  }
  checkpointCache.set(filePath, cp);
  return cp;
}

/** Append one event to a per-goal recent tail, keeping the newest cap entries. */
function appendRecent(recent: Map<string, GoalLedgerEvent[]>, goalId: string, event: GoalLedgerEvent): void {
  const tail = recent.get(goalId) ?? [];
  tail.push(event);
  if (tail.length > CHECKPOINT_RECENT_CAP) tail.splice(0, tail.length - CHECKPOINT_RECENT_CAP);
  recent.set(goalId, tail);
}

/** Build a checkpoint from full events (used to bootstrap / refresh). */
function buildCheckpointFromEvents(events: GoalLedgerEvent[], coveredBytes: number): LedgerCheckpoint {
  const runtimeIndex = buildLedgerIndex(events);
  return {
    version: LEDGER_CHECKPOINT_VERSION,
    format: "goal-ledger-checkpoint",
    createdAt: nowIso(),
    coveredBytes,
    coveredEvents: events.length,
    acc: applyLedgerEvents(freshAccumulator(), events),
    recentEventsByGoal: new Map(Array.from(runtimeIndex, ([id, entry]) => [id, [...entry.recent]])),
    runtimeIndex,
  };
}

/** Positioned read of the ledger bytes past `offset`, parsed as JSONL. */
function readLedgerTailFrom(filePath: string, offset: number): GoalLedgerReadResult {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.max(0, size - offset);
      const buf = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, buf, 0, len, offset);
      return parseLedgerLines(buf.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { events: [], malformed: 0 };
  }
}

/**
 * Maintain the checkpoint after an in-process append (best-effort).
 *
 * Requires an existing checkpoint or a warm full-event cache to extend the
 * accumulator incrementally; otherwise the checkpoint is deferred to the next
 * cold load (bootstrap). Failures are swallowed — the ledger append itself is
 * authoritative and never rolled back.
 */
function updateLedgerCheckpointAfterAppend(filePath: string, lines: string, events: GoalLedgerEvent[]): void {
  try {
    let cp = checkpointCache.get(filePath);
    if (cp === undefined) cp = readLedgerCheckpointFile(filePath);
    if (!cp) {
      const cached = ledgerCache.get(filePath);
      if (!cached) return;
      cp = buildCheckpointFromEvents(cached.events, cached.size);
      checkpointCache.set(filePath, cp);
      writeLedgerCheckpointAtomic(filePath, cp);
      lastCheckpointDiskWrite.set(filePath, { appendsSinceWrite: cp.coveredEvents, at: Date.now() });
      return;
    }
    for (const event of events) { applyLedgerEvent(cp.acc, event); indexLedgerEvent(cp.runtimeIndex, event); }
    cp.coveredBytes += Buffer.byteLength(lines, "utf8");
    cp.coveredEvents += events.length;
    for (const event of events) {
      const goalId = goalIdOf(event);
      if (goalId) appendRecent(cp.recentEventsByGoal, goalId, event);
    }
    cp.createdAt = nowIso();
    checkpointCache.set(filePath, cp);
    const last = lastCheckpointDiskWrite.get(filePath) ?? { appendsSinceWrite: 0, at: 0 };
    const sinceWrite = cp.coveredEvents - last.appendsSinceWrite;
    if (sinceWrite >= CHECKPOINT_WRITE_INTERVAL || Date.now() - last.at >= CHECKPOINT_WRITE_MIN_MS) {
      writeLedgerCheckpointAtomic(filePath, cp);
      lastCheckpointDiskWrite.set(filePath, { appendsSinceWrite: cp.coveredEvents, at: Date.now() });
    }
  } catch {
    // Best-effort only.
  }
}

/**
 * Bounded cold read of the ledger's reconstructed state (reliability campaign).
 *
 * Serves in this priority order:
 *  - warm cache: zero fs ops, same semantics as today's consumers;
 *  - fresh checkpoint: 2 fs ops (checkpoint read + stat);
 *  - checkpoint + grown ledger: positioned tail read + incremental replay;
 *  - no/valid-but-stale-beyond-use checkpoint: full parse + reconstruct, then
 *    writes a fresh checkpoint so the next session is bounded.
 */
/** Current bounded runtime projections, initialized once from checkpoint + tail. */
function runtimeIndex(ctx: GoalLedgerContext): Map<string, GoalLedgerIndex> {
 const filePath = goalLedgerPath(ctx);
 if (!runtimeReady.has(filePath)) {
  loadLedgerState(ctx);
  const cp = checkpointCache.get(filePath);
  if (!cp) {
   const full = readGoalLedger(ctx);
   checkpointCache.set(filePath, buildCheckpointFromEvents(full.events, ledgerCache.get(filePath)?.size ?? 0));
  }
  // Hot consumers do not retain a second full-history representation.
  ledgerCache.delete(filePath);
  runtimeReady.add(filePath);
 }
 return checkpointCache.get(filePath)!.runtimeIndex;
}
const runtimeReady = new Set<string>();
export function goalActivityEvents(ctx: GoalLedgerContext, goalId: string): GoalLedgerEvent[] {
 return indexedActivityEvents(runtimeIndex(ctx).get(goalId)?.activity ?? []);
}
export function goalRuntimeEvents(ctx: GoalLedgerContext, goalId: string): GoalLedgerEvent[] {
 const entry = runtimeIndex(ctx).get(goalId);
 if (!entry) return [];
 const recent = entry.recent;
 const same = (a: GoalLedgerEvent | undefined, b: GoalLedgerEvent | undefined) => a === b || !!a && !!b && a.type === b.type && a.at === b.at && JSON.stringify(a) === JSON.stringify(b);
 const prior = same(entry.settledAudit, entry.audit) ? undefined : entry.settledAudit;
 const pinned = [prior, entry.completion, entry.auditStarted, entry.audit];
 return [...pinned.filter((event, index): event is GoalLedgerEvent => !!event
  && !recent.some(other => same(event, other))
  && !pinned.slice(0, index).some(other => same(event, other))), ...recent];
}
export function goalOracleState(ctx: GoalLedgerContext, goalId: string, fingerprint: string) {
 const state = runtimeIndex(ctx).get(goalId)?.oracle.get(fingerprint);
 return state ? { ...state } : { failedAttempts: 0, followupAttempted: false };
}

export function loadLedgerState(ctx: GoalLedgerContext): LedgerStateReadResult {
  const filePath = goalLedgerPath(ctx);
  const cached = ledgerCache.get(filePath);
  if (cached) {
    let cp = checkpointCache.get(filePath);
    if (!cp || cp.coveredBytes !== cached.size || cp.coveredEvents !== cached.events.length) {
      cp = buildCheckpointFromEvents(cached.events, cached.size);
      checkpointCache.set(filePath, cp);
    }
    return {
      state: finalizeLedgerState(cloneAccumulator(cp.acc)),
      recentEventsByGoal: new Map(cp.recentEventsByGoal),
      malformed: cached.malformed,
      coveredBytes: cached.size,
      coveredEvents: cached.events.length,
      source: "cache",
    };
  }
  const cp = readLedgerCheckpointFile(filePath);
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = 0;
  }
  if (cp && cp.coveredBytes === size) {
    return {
      state: finalizeLedgerState(cloneAccumulator(cp.acc)),
      recentEventsByGoal: new Map(cp.recentEventsByGoal),
      malformed: 0,
      coveredBytes: cp.coveredBytes,
      coveredEvents: cp.coveredEvents,
      source: "checkpoint",
    };
  }
  if (cp && cp.coveredBytes < size) {
    const tail = readLedgerTailFrom(filePath, cp.coveredBytes);
    const acc = cloneAccumulator(cp.acc);
    const recent = new Map(cp.recentEventsByGoal);
    for (const event of tail.events) {
      applyLedgerEvent(acc, event);
      indexLedgerEvent(cp.runtimeIndex, event);
      const goalId = goalIdOf(event);
      if (goalId) appendRecent(recent, goalId, event);
    }
    const state = finalizeLedgerState(acc);
    const updated: LedgerCheckpoint = {
      ...cp,
      acc,
      recentEventsByGoal: recent,
      coveredBytes: size,
      coveredEvents: cp.coveredEvents + tail.events.length,
      createdAt: nowIso(),
    };
    checkpointCache.set(filePath, updated);
    writeLedgerCheckpointAtomic(filePath, updated);
    lastCheckpointDiskWrite.set(filePath, { appendsSinceWrite: updated.coveredEvents, at: Date.now() });
    return { state, recentEventsByGoal: recent, malformed: tail.malformed, coveredBytes: size, coveredEvents: updated.coveredEvents, source: "tail" };
  }
  // Full fallback: missing/corrupt checkpoint, version mismatch, or the ledger
  // was rewritten to be smaller than the checkpoint's coverage.
  const full = readGoalLedgerCold(ctx, filePath);
  const fresh = buildCheckpointFromEvents(full.events, size);
  checkpointCache.set(filePath, fresh);
  writeLedgerCheckpointAtomic(filePath, fresh);
  lastCheckpointDiskWrite.set(filePath, { appendsSinceWrite: fresh.coveredEvents, at: Date.now() });
  return {
    state: finalizeLedgerState(cloneAccumulator(fresh.acc)),
    recentEventsByGoal: new Map(fresh.recentEventsByGoal),
    malformed: full.malformed,
    coveredBytes: size,
    coveredEvents: full.events.length,
    source: "full",
  };
}


function isValidLedgerEvent(value: unknown): value is GoalLedgerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") return false;
  if (typeof obj.at !== "string") return false;
  const type = obj.type as GoalLedgerEvent["type"];
  if ((type === "audit_started" || type === "audit_result" || type === "audit_skipped") && obj.auditId !== undefined && (typeof obj.auditId !== "string" || !obj.auditId)) return false;
  switch (type) {
    case "goal_created":
      return typeof obj.goalId === "string" && typeof obj.objective === "string" && typeof obj.sisyphus === "boolean" && typeof obj.autoContinue === "boolean";
    case "goal_focused":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_unfocused":
      return typeof obj.reason === "string";
    case "goal_paused":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.suggestedAction === undefined || typeof obj.suggestedAction === "string") && (obj.status === undefined || obj.status === "paused") && (obj.source === undefined || obj.source === "user" || obj.source === "agent");
    case "goal_resumed":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_tweaked":
      return typeof obj.goalId === "string" && typeof obj.changeSummary === "string";
    case "auditor_toggled":
      return typeof obj.goalId === "string" && typeof obj.enabled === "boolean";
    case "completion_requested":
      return typeof obj.goalId === "string" && (obj.summary === undefined || typeof obj.summary === "string");
    case "audit_started":
      return typeof obj.goalId === "string" && (obj.provider === undefined || typeof obj.provider === "string") && (obj.model === undefined || typeof obj.model === "string") && (obj.thinkingLevel === undefined || typeof obj.thinkingLevel === "string");
    case "audit_result":
      return typeof obj.goalId === "string" && (obj.verdict === "approved" || obj.verdict === "disapproved" || obj.verdict === "error") && typeof obj.report === "string";
    case "audit_skipped":
      return typeof obj.goalId === "string" && (obj.reason === "disabled" || obj.reason === "user_aborted") && (obj.provider === undefined || typeof obj.provider === "string") && (obj.model === undefined || typeof obj.model === "string") && (obj.thinkingLevel === undefined || typeof obj.thinkingLevel === "string");
    case "goal_completed":
      return typeof obj.goalId === "string" && (obj.archivePath === undefined || typeof obj.archivePath === "string");
    case "goal_archived":
      return typeof obj.goalId === "string" && typeof obj.archivePath === "string";
    case "goal_archive_failed":
      return typeof obj.goalId === "string" && typeof obj.message === "string";
    case "goal_aborted":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.archivePath === undefined || typeof obj.archivePath === "string");
    case "task_list_set":
      return typeof obj.goalId === "string" && typeof obj.taskCount === "number" && typeof obj.blockCompletion === "boolean";
    case "task_complete":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string" && (obj.evidence === undefined || typeof obj.evidence === "string");
    case "task_skipped":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string" && typeof obj.reason === "string";
    case "task_reopened":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string";
    case "task_started":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string";
    case "goal_budget_changed":
      return typeof obj.goalId === "string" && (obj.oldBudget === null || (Number.isSafeInteger(obj.oldBudget) && Number(obj.oldBudget) > 0)) && (obj.newBudget === null || (Number.isSafeInteger(obj.newBudget) && Number(obj.newBudget) > 0)) && typeof obj.tokensUsed === "number";
    case "goal_budget_limited":
      return typeof obj.goalId === "string" && typeof obj.budget === "number" && typeof obj.tokensUsed === "number";
    case "goal_budget_warning":
      return typeof obj.goalId === "string" && typeof obj.budget === "number" && typeof obj.tokensUsed === "number" && typeof obj.pct === "number";
    case "goal_stalled":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_blocked":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.source === "agent" || obj.source === "system");
    case "oracle_started":
      return typeof obj.goalId === "string" && typeof obj.fingerprint === "string" && typeof obj.provider === "string" && typeof obj.model === "string" && typeof obj.reason === "string" && (obj.thinkingLevel === undefined || typeof obj.thinkingLevel === "string");
    case "oracle_result":
      return typeof obj.goalId === "string" && typeof obj.fingerprint === "string" && typeof obj.adviceId === "string" && (obj.disposition === "actionable" || obj.disposition === "needs_human" || obj.disposition === "insufficient_context") && typeof obj.summary === "string";
    case "oracle_failed":
      return typeof obj.goalId === "string" && typeof obj.fingerprint === "string" && typeof obj.attempt === "number" && (obj.errorCode === "config" || obj.errorCode === "provider" || obj.errorCode === "aborted" || obj.errorCode === "invalid_output") && typeof obj.message === "string";
    case "oracle_followup_attempted":
      return typeof obj.goalId === "string" && typeof obj.fingerprint === "string" && typeof obj.adviceId === "string" && typeof obj.firstToolName === "string";
    default:
      return false;
  }
}

function sanitizeEvent(event: GoalLedgerEvent, owned = false): GoalLedgerEvent {
  if (!("goalId" in event)) return event;
  const goalId = safeGoalId(event.goalId);
  // Parsed JSON is privately owned; avoid allocating a second object per line.
  // Caller-supplied append events still get a defensive copy.
  if (owned) { event.goalId = goalId; return event; }
  return { ...event, goalId };
}

export function reconstructGoalLedger(events: GoalLedgerEvent[]): ReconstructedLedgerState {
  // Inline accumulator allocation (no helper call on the measured path).
  return finalizeLedgerState(applyLedgerEvents({
    goals: new Map(),
    terminalGoals: new Map(),
    focusedGoalId: null,
    focusGeneration: 0,
    focusGenByGoal: new Map(),
  }, events));
}

/**
 * Incremental reconstruction accumulator (checkpoint support).
 *
 * reconstructGoalLedger(events) === finalizeLedgerState(applyLedgerEvents(fresh(), events)),
 * so a checkpoint can store the accumulator mid-stream and replay only the
 * ledger tail by applying the remaining events, then finalizing once.
 */
export interface ReconstructAccumulator {
  goals: Map<string, ReconstructedGoalState>;
  terminalGoals: Map<string, ReconstructedGoalState>;
  focusedGoalId: string | null;
  focusGeneration: number;
  focusGenByGoal: Map<string, number>;
}

export function freshAccumulator(): ReconstructAccumulator {
  return {
    goals: new Map(),
    terminalGoals: new Map(),
    focusedGoalId: null,
    focusGeneration: 0,
    focusGenByGoal: new Map(),
  };
}

function applyLedgerEvents(acc: ReconstructAccumulator, events: GoalLedgerEvent[]): ReconstructAccumulator {
  // Locals instead of property chains: B3.reconstruct is measured over 10k
  // event lists and must hold the NAF 10x headroom (0.3ms at 5k).
  const goals = acc.goals;
  const terminalGoals = acc.terminalGoals;
  const focusGenByGoal = acc.focusGenByGoal;
  let focusedGoalId = acc.focusedGoalId;
  let focusGeneration = acc.focusGeneration;
  for (const event of events) {
    switch (event.type) {
      case "goal_created": {
        const state: ReconstructedGoalState = {
          goalId: event.goalId,
          latestStatus: "active",
          latestFocus: false,
          createdAt: event.at,
        };
        goals.set(event.goalId, state);
        break;
      }
      case "goal_focused": {
        focusedGoalId = event.goalId;
        focusGeneration++;
        const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
        if (state) focusGenByGoal.set(event.goalId, focusGeneration);
        break;
      }
      case "goal_unfocused": {
        focusedGoalId = null;
        focusGeneration++;
        break;
      }
      case "goal_paused": {
        const state = goals.get(event.goalId);
        if (state) {
          state.latestStatus = event.status ?? "paused";
          state.latestPauseReason = event.reason;
          state.latestPauseSuggestedAction = event.suggestedAction;
        }
        break;
      }
      case "goal_resumed": {
        const state = goals.get(event.goalId);
        if (state) {
          state.latestStatus = "active";
          state.resumedAt = event.at;
          delete state.latestPauseReason;
          delete state.latestPauseSuggestedAction;
        }
        break;
      }
      case "goal_tweaked": {
        const state = goals.get(event.goalId);
        if (state) state.tweakedAt = event.at;
        break;
      }
      case "completion_requested": {
        // No status change until audit_result or goal_completed
        break;
      }
      case "audit_started":
      case "audit_skipped":
      case "audit_result": {
        const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
        if (state && auditApplies(state.latestAuditId, event)) {
          state.latestAuditId = event.auditId;
          state.latestAuditorResult = event.type === "audit_result"
            ? {verdict: event.verdict, report: event.report, at: event.at} : undefined;
        }
        break;
      }
      case "goal_completed": {
        let state = goals.get(event.goalId);
        if (!state) {
          state = { goalId: event.goalId, latestStatus: "complete", latestFocus: false };
        }
        state.latestStatus = "complete";
        state.completedAt = event.at;
        terminalGoals.set(event.goalId, state);
        goals.delete(event.goalId);
        break;
      }
      case "goal_aborted": {
        let state = goals.get(event.goalId);
        if (!state) {
          state = { goalId: event.goalId, latestStatus: "aborted", latestFocus: false };
        }
        state.latestStatus = "aborted";
        state.abortedAt = event.at;
        terminalGoals.set(event.goalId, state);
        goals.delete(event.goalId);
        break;
      }
      case "oracle_started":
      case "oracle_failed":
      case "oracle_followup_attempted": {
        // Bounded metadata only; no reconstructed state change.
        break;
      }
      case "oracle_result": {
        const oracleState = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
        if (oracleState) {
          oracleState.latestOracleResult = {
            fingerprint: event.fingerprint,
            adviceId: event.adviceId,
            disposition: event.disposition,
            summary: event.summary,
            at: event.at,
          };
        }
        break;
      }
    }
  }
  acc.focusedGoalId = focusedGoalId;
  acc.focusGeneration = focusGeneration;
  return acc;
}

/** Apply one ledger event (checkpoint incremental paths; not on the measured hot path). */
function applyLedgerEvent(acc: ReconstructAccumulator, event: GoalLedgerEvent): void {
  applyLedgerEvents(acc, [event]);
}

/** Materialize focus flags once (O(goals)), clearing focus on terminal goals. */
function finalizeLedgerState(acc: ReconstructAccumulator): ReconstructedLedgerState {
  const { goals, terminalGoals, focusGenByGoal } = acc;
  const focusGeneration = acc.focusGeneration;
  // Materialize the generation-based focus flags (O(goals) once, not per event).
  for (const g of goals.values()) g.latestFocus = focusGenByGoal.get(g.goalId) === focusGeneration;
  for (const g of terminalGoals.values()) g.latestFocus = focusGenByGoal.get(g.goalId) === focusGeneration;

  // If the focused goal was moved to terminal (e.g., aborted/completed), clear focus.
  if (acc.focusedGoalId && !goals.has(acc.focusedGoalId)) {
    acc.focusedGoalId = null;
  }

  return { focusedGoalId: acc.focusedGoalId, goals, terminalGoals };
}

/** Shallow-clone an accumulator so finalizing (or extending) never mutates a cached copy. */
function cloneAccumulator(acc: ReconstructAccumulator): ReconstructAccumulator {
  return {
    goals: new Map(acc.goals),
    terminalGoals: new Map(acc.terminalGoals),
    focusedGoalId: acc.focusedGoalId,
    focusGeneration: acc.focusGeneration,
    focusGenByGoal: new Map(acc.focusGenByGoal),
  };
}

type AuditEvent = Extract<GoalLedgerEvent, {type: "audit_started" | "audit_result" | "audit_skipped"}>;

/** New attempts supersede old verdicts; overlapping attempts match by identity. */
export function latestAuditForGoal(events: GoalLedgerEvent[], goalId: string): AuditEvent | undefined {
 let latest: AuditEvent | undefined;
 for (const event of events) {
  if ((event.type === "audit_started" || event.type === "audit_result" || event.type === "audit_skipped") && event.goalId === goalId && auditApplies(latest?.auditId, event)) latest = event;
 }
 return latest;
}

export function latestAuditorResultForGoal(events: GoalLedgerEvent[], goalId: string): {verdict: "approved" | "disapproved" | "error"; report: string; at: string} | undefined {
 const latest = latestAuditForGoal(events, goalId);
 return latest?.type === "audit_result" ? {verdict: latest.verdict, report: latest.report, at: latest.at} : undefined;
}

export function latestSettledAuditorResultForGoal(events: GoalLedgerEvent[], goalId: string): { verdict: "approved" | "disapproved" | "error"; report: string; at: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === "audit_result" && event.goalId === goalId) {
      return { verdict: event.verdict, report: event.report, at: event.at };
    }
  }
  return undefined;
}

export function latestEventsForGoal(events: GoalLedgerEvent[], goalId: string, limit = 10): GoalLedgerEvent[] {
  const result: GoalLedgerEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if ("goalId" in event && event.goalId === goalId) {
      result.unshift(event);
      if (result.length >= limit) break;
    }
  }
  return result;
}

