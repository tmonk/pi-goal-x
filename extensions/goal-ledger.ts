import { goalStoragePath, ensureGoalStorageDirectory, isExternalGoalStorage, type GoalStorageContext } from "./storage/goal-root.ts";
import { indexedActivityEvents } from "./goal-activity.ts";
import { buildLedgerIndex, indexLedgerEvent, auditApplies, type GoalLedgerIndex } from "./goal-ledger-index.ts";
import {
	LEDGER_CHECKPOINT_FILE,
	LEDGER_CHECKPOINT_VERSION,
	checkpointFromJson,
	checkpointToJson,
	type LedgerCheckpoint,
	type ReconstructAccumulator,
	type ReconstructedGoalState,
} from "./goal-ledger-checkpoint.ts";
import { isValidLedgerEvent, sanitizeEvent } from "./goal-ledger-validate.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "./storage/atomic-rename.ts";
import { nowIso, safeIdPart } from "./goal-record.ts";

export { LEDGER_CHECKPOINT_FILE, LEDGER_CHECKPOINT_VERSION };

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

interface GoalLedgerReadResult {
	events: GoalLedgerEvent[];
	malformed: number;
	/** Opaque generation for borrowed, read-only history views; replaced on append/refresh. */
	revision?: object;
}

interface ReconstructedLedgerState {
	focusedGoalId: string | null;
	goals: Map<string, ReconstructedGoalState>;
	terminalGoals: Map<string, ReconstructedGoalState>;
}

export function goalLedgerPath(ctx: GoalLedgerContext): string {
	return goalStoragePath(ctx, GOAL_LEDGER_FILE);
}

type GoalLedgerAppendResult = { ok: true } | { ok: false; error: unknown };

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
	return appendLedgerLines(ctx, [event]);
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
	return readGoalLedgerCold(filePath);
}

/** Cold read: full file read + parse, populating the zero-op cache. */
function readGoalLedgerCold(filePath: string): GoalLedgerReadResult {
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
					if (id === undefined) { id = safeIdPart(parsed.goalId); if (goalIds.size < 1024) goalIds.set(parsed.goalId, id); }
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

interface LedgerStateReadResult {
	state: ReconstructedLedgerState;
	recentEventsByGoal: Map<string, GoalLedgerEvent[]>;
	malformed: number;
	coveredBytes: number;
	coveredEvents: number;
	source: "cache" | "checkpoint" | "tail" | "full";
}

const CHECKPOINT_RECENT_CAP = 12;

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

/**
 * Atomic checkpoint write (temp file + rename in the ledger directory) that
 * also resets the write throttle. Best-effort.
 */
function writeLedgerCheckpointAtomic(filePath: string, cp: LedgerCheckpoint): void {
	try {
		writeFileAtomicSync(checkpointPathFor(filePath), JSON.stringify(checkpointToJson(cp)));
	} catch (err) {
		// The checkpoint is an optimization; a failed write only costs a full
		// parse on the next cold read.
		console.error("[goal-ledger] checkpoint write failed:", err);
	}
	lastCheckpointDiskWrite.set(filePath, { appendsSinceWrite: cp.coveredEvents, at: Date.now() });
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
			return;
		}
		for (const event of events) { applyLedgerEvents(cp.acc, [event]); indexLedgerEvent(cp.runtimeIndex, event); }
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
		}
	} catch {
		// Best-effort only.
	}
}

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
			applyLedgerEvents(acc, [event]);
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
		return { state, recentEventsByGoal: recent, malformed: tail.malformed, coveredBytes: size, coveredEvents: updated.coveredEvents, source: "tail" };
	}
	// Full fallback: missing/corrupt checkpoint, version mismatch, or the ledger
	// was rewritten to be smaller than the checkpoint's coverage.
	const full = readGoalLedgerCold(filePath);
	const fresh = buildCheckpointFromEvents(full.events, size);
	checkpointCache.set(filePath, fresh);
	writeLedgerCheckpointAtomic(filePath, fresh);
	return {
		state: finalizeLedgerState(cloneAccumulator(fresh.acc)),
		recentEventsByGoal: new Map(fresh.recentEventsByGoal),
		malformed: full.malformed,
		coveredBytes: size,
		coveredEvents: full.events.length,
		source: "full",
	};
}


export function reconstructGoalLedger(events: GoalLedgerEvent[]): ReconstructedLedgerState {
	return finalizeLedgerState(applyLedgerEvents(freshAccumulator(), events));
}

function freshAccumulator(): ReconstructAccumulator {
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

	/** Move a goal to the terminal map, creating a stub when its creation event is missing. */
	const settle = (goalId: string, status: "complete" | "aborted"): ReconstructedGoalState => {
		const state = goals.get(goalId) ?? { goalId, latestStatus: status, latestFocus: false };
		state.latestStatus = status;
		terminalGoals.set(goalId, state);
		goals.delete(goalId);
		return state;
	};

	for (const event of events) {
		switch (event.type) {
			case "goal_created":
				goals.set(event.goalId, { goalId: event.goalId, latestStatus: "active", latestFocus: false, createdAt: event.at });
				break;
			case "goal_focused":
				focusedGoalId = event.goalId;
				focusGeneration++;
				if (goals.has(event.goalId) || terminalGoals.has(event.goalId)) focusGenByGoal.set(event.goalId, focusGeneration);
				break;
			case "goal_unfocused":
				focusedGoalId = null;
				focusGeneration++;
				break;
			case "goal_paused": {
				const state = goals.get(event.goalId);
				if (!state) break;
				state.latestStatus = event.status ?? "paused";
				state.latestPauseReason = event.reason;
				state.latestPauseSuggestedAction = event.suggestedAction;
				break;
			}
			case "goal_resumed": {
				const state = goals.get(event.goalId);
				if (!state) break;
				state.latestStatus = "active";
				state.resumedAt = event.at;
				delete state.latestPauseReason;
				delete state.latestPauseSuggestedAction;
				break;
			}
			case "goal_tweaked": {
				const state = goals.get(event.goalId);
				if (state) state.tweakedAt = event.at;
				break;
			}
			case "audit_started":
			case "audit_skipped":
			case "audit_result": {
				const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
				if (state && auditApplies(state.latestAuditId, event)) {
					state.latestAuditId = event.auditId;
					state.latestAuditorResult = event.type === "audit_result"
						? { verdict: event.verdict, report: event.report, at: event.at }
						: undefined;
				}
				break;
			}
			case "goal_completed":
				settle(event.goalId, "complete").completedAt = event.at;
				break;
			case "goal_aborted":
				settle(event.goalId, "aborted").abortedAt = event.at;
				break;
			case "oracle_result": {
				const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
				if (state) {
					state.latestOracleResult = {
						fingerprint: event.fingerprint,
						adviceId: event.adviceId,
						disposition: event.disposition,
						summary: event.summary,
						at: event.at,
					};
				}
				break;
			}
			default:
				// Other events (completion requests, oracle metadata, tasks, budgets)
				// do not change reconstructed state.
				break;
		}
	}
	acc.focusedGoalId = focusedGoalId;
	acc.focusGeneration = focusGeneration;
	return acc;
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

