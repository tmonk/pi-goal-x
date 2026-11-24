/**
 * The in-process side of the ledger checkpoint: the checkpoint mirror, the
 * disk-write throttle, reading and writing the checkpoint file, and keeping
 * the mirror current after an append. The file format and its validation live
 * in goal-ledger-checkpoint.ts.
 *
 * The checkpoint (reliability campaign 2026-08-09) bounds the COLD path. The
 * zero-op cache covers steady-state reads, but a fresh session would still
 * read and parse the whole JSONL ledger. The checkpoint stores the
 * reconstructed accumulator, the per-goal recent-event tails and the byte
 * position of the ledger it covers. A cold read then costs 2 fs ops
 * (checkpoint read + stat) when covered, or a bounded positioned tail read
 * when the ledger grew. The JSONL ledger stays authoritative: a missing,
 * corrupt or version-mismatched checkpoint falls back to the full parse, and
 * any coveredBytes mismatch (external edit, truncation) falls back or replays
 * the tail.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "./storage/atomic-rename.ts";
import {
	LEDGER_CHECKPOINT_FILE,
	LEDGER_CHECKPOINT_VERSION,
	checkpointFromJson,
	checkpointToJson,
	type LedgerCheckpoint,
} from "./goal-ledger-checkpoint.ts";
import type { GoalLedgerEvent } from "./goal-ledger-events.ts";
import { buildLedgerIndex, indexLedgerEvent } from "./goal-ledger-index.ts";
import { applyLedgerEvents, freshAccumulator } from "./goal-ledger-reconstruct.ts";
import { nowIso } from "./goal-record.ts";

const CHECKPOINT_RECENT_CAP = 12;

/** In-process checkpoint mirror (null = known absent). */
export const checkpointCache = new Map<string, LedgerCheckpoint | null>();

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

export function goalIdOf(event: GoalLedgerEvent): string | null {
	return "goalId" in event ? event.goalId : null;
}

function checkpointPathFor(filePath: string): string {
	return path.join(path.dirname(filePath), LEDGER_CHECKPOINT_FILE);
}

/**
 * Atomic checkpoint write (temp file + rename in the ledger directory) that
 * also resets the write throttle. Best-effort.
 */
export function writeLedgerCheckpointAtomic(filePath: string, cp: LedgerCheckpoint): void {
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
export function readLedgerCheckpointFile(filePath: string): LedgerCheckpoint | null {
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
export function appendRecent(recent: Map<string, GoalLedgerEvent[]>, goalId: string, event: GoalLedgerEvent): void {
	const tail = recent.get(goalId) ?? [];
	tail.push(event);
	if (tail.length > CHECKPOINT_RECENT_CAP) tail.splice(0, tail.length - CHECKPOINT_RECENT_CAP);
	recent.set(goalId, tail);
}

/** Build a checkpoint from full events (used to bootstrap / refresh). */
export function buildCheckpointFromEvents(events: GoalLedgerEvent[], coveredBytes: number): LedgerCheckpoint {
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

/**
 * Maintain the checkpoint after an in-process append (best-effort).
 *
 * Requires an existing checkpoint or the warm full-event cache (`warm`) to extend the
 * accumulator incrementally; otherwise the checkpoint is deferred to the next
 * cold load (bootstrap). Failures are swallowed — the ledger append itself is
 * authoritative and never rolled back.
 */
export function updateLedgerCheckpointAfterAppend(
	filePath: string,
	lines: string,
	events: GoalLedgerEvent[],
	warm: { events: GoalLedgerEvent[]; size: number } | undefined,
): void {
	try {
		let cp = checkpointCache.get(filePath);
		if (cp === undefined) cp = readLedgerCheckpointFile(filePath);
		if (!cp) {
			if (!warm) return;
			cp = buildCheckpointFromEvents(warm.events, warm.size);
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

/** Forget the mirror and the write throttle (session boundary). */
export function resetCheckpointState(): void {
	checkpointCache.clear();
	lastCheckpointDiskWrite.clear();
}
