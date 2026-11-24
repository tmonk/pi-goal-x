import * as fs from "node:fs";
import * as path from "node:path";
import { goalStoragePath, ensureGoalStorageDirectory, isExternalGoalStorage, type GoalStorageContext } from "./storage/goal-root.ts";
import { indexedActivityEvents } from "./goal-activity.ts";
import { indexLedgerEvent, type GoalLedgerIndex } from "./goal-ledger-index.ts";
import { LEDGER_CHECKPOINT_FILE, LEDGER_CHECKPOINT_VERSION, type LedgerCheckpoint } from "./goal-ledger-checkpoint.ts";
import {
	appendRecent,
	buildCheckpointFromEvents,
	checkpointCache,
	goalIdOf,
	readLedgerCheckpointFile,
	resetCheckpointState,
	updateLedgerCheckpointAfterAppend,
	writeLedgerCheckpointAtomic,
} from "./goal-ledger-checkpoint-store.ts";
import type { GoalLedgerEvent } from "./goal-ledger-events.ts";
import {
	applyLedgerEvents,
	cloneAccumulator,
	finalizeLedgerState,
	type ReconstructedLedgerState,
} from "./goal-ledger-reconstruct.ts";
import { isValidLedgerEvent, sanitizeEvent } from "./goal-ledger-validate.ts";
import { nowIso, safeIdPart } from "./goal-record.ts";

// Importers take the event type, the event-list queries and the fold from here.
export { LEDGER_CHECKPOINT_FILE, LEDGER_CHECKPOINT_VERSION };
export type { GoalLedgerEvent };
export { reconstructGoalLedger } from "./goal-ledger-reconstruct.ts";
export { latestAuditForGoal, latestAuditorResultForGoal, latestEventsForGoal, latestSettledAuditorResultForGoal } from "./goal-ledger-queries.ts";

export const GOAL_LEDGER_FILE = ".pi/goals/goal_events.jsonl";

export type GoalLedgerContext = GoalStorageContext;

interface GoalLedgerReadResult {
	events: GoalLedgerEvent[];
	malformed: number;
	/** Opaque generation for borrowed, read-only history views; replaced on append/refresh. */
	revision?: object;
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
	updateLedgerCheckpointAfterAppend(filePath, lines, events, ledgerCache.get(filePath));
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
	resetCheckpointState();
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
