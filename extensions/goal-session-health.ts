/**
 * Issue #30 — checkpoint health diagnostics for existing session files.
 *
 * Read-only inspection of a session JSONL's persisted continuation
 * checkpoints. Pre-fix sessions accumulated one FULL continuation prompt per
 * auto-continue turn (~6.4K chars each); v2 checkpoints are bounded markers.
 * The report quantifies what an offline repair with pi-goal-x-recover would
 * save. This module never writes anything.
 */

import * as fs from "node:fs";
import { GOAL_EVENT_ENTRY } from "./goal-format.ts";
import { asRecord } from "./goal-record.ts";

/** Exact shape written by checkpointTriggerPrompt() (v2 markers only). */
const V2_MARKER_PATTERN =
	/^<pi_goal_continuation\s+goal_id="[^"]+"\s+kind="checkpoint"\s+v="2"\s*\/>$/;

/** Approximate persisted size of one repaired marker, used for projections. */
export const REPAIRED_MARKER_ESTIMATE_CHARS = "<pi_goal_continuation goal_id=xxxxxxxxxxxxxxxxxxxx kind=\"checkpoint\" v=\"2\"/>".length;

export interface CheckpointHealth {
	total: number;
	legacyFull: number;
	v2Minimal: number;
	totalContentChars: number;
	recoverableChars: number;
	largestCheckpointChars: number;
}

function emptyHealth(): CheckpointHealth {
	return {
		total: 0,
		legacyFull: 0,
		v2Minimal: 0,
		totalContentChars: 0,
		recoverableChars: 0,
		largestCheckpointChars: 0,
	};
}

function isCheckpointEntry(entry: unknown): { content: string; version: number | undefined } | null {
	const raw = asRecord(entry);
	if (!raw || raw.type !== "custom_message") return null;
	if (raw.customType !== GOAL_EVENT_ENTRY) return null;
	if (typeof raw.content !== "string") return null;
	const details = asRecord(raw.details);
	return { content: raw.content, version: typeof details?.version === "number" ? details.version : undefined };
}

/**
 * Classify every pi-goal-event custom message in parsed session entries.
 * v2 entries match the exact bounded marker shape AND carry details.version 2;
 * everything else is legacy full-prompt payload that offline recovery can
 * shrink.
 */
export function inspectCheckpointHealth(entries: readonly unknown[]): CheckpointHealth {
	const health = emptyHealth();
	for (const entry of entries) accumulateCheckpointHealth(health, entry);
	return health;
}

function accumulateCheckpointHealth(health: CheckpointHealth, entry: unknown): void {
	const checkpoint = isCheckpointEntry(entry);
	if (!checkpoint) return;
	health.total += 1;
	health.totalContentChars += checkpoint.content.length;
	if (checkpoint.content.length > health.largestCheckpointChars) {
		health.largestCheckpointChars = checkpoint.content.length;
	}
	const isV2 = (checkpoint.version === 2 || checkpoint.version === 3) && V2_MARKER_PATTERN.test(checkpoint.content);
	if (isV2) {
		health.v2Minimal += 1;
	} else {
		health.legacyFull += 1;
		health.recoverableChars += checkpoint.content.length;
	}
}

/**
 * Convenience wrapper: read a session JSONL file from disk (JSON per line,
 * header included) and inspect its checkpoints. Returns null when the file
 * does not exist or cannot be read/parsed at the line level — malformed lines
 * are skipped, not fatal, mirroring the recovery CLI's tolerance.
 */
export function readSessionCheckpointHealth(sessionFile: string): CheckpointHealth | null {
	let raw: string;
	try {
		raw = fs.readFileSync(sessionFile, "utf8");
	} catch {
		return null;
	}
	const health = emptyHealth();
	// Parse and discard one entry at a time; do not retain the whole session object graph.
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.trim();
		if (line) try { accumulateCheckpointHealth(health, JSON.parse(line)); } catch { /* tolerate malformed lines */ }
	}
	return health;
}

/** Human-readable projection of post-recovery checkpoint content size. */
export function projectedContentCharsAfterRecovery(health: CheckpointHealth): number {
	return health.v2Minimal * REPAIRED_MARKER_ESTIMATE_CHARS;
}

function formatChars(chars: number): string {
	if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
	if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)} KB`;
	return `${chars} chars`;
}

/**
 * Render the read-only report section. The command layer appends this to
 * /goal-recovery output and /goal-status health when checkpoint data exists.
 */
export function formatCheckpointHealthReport(health: CheckpointHealth, sessionFile?: string): string {
	const lines: string[] = [];
	lines.push("Session checkpoints:");
	lines.push(`  total: ${health.total}`);
	lines.push(`  legacy full checkpoints: ${health.legacyFull}`);
	lines.push(`  v2 minimal markers: ${health.v2Minimal}`);
	lines.push(`  checkpoint content: ${formatChars(health.totalContentChars)}`);
	lines.push(`  projected content after recovery: ${formatChars(projectedContentCharsAfterRecovery(health))}`);
	if (health.legacyFull > 0 && sessionFile) {
		lines.push("  close Pi, then run:");
		lines.push(`    pi-goal-x-recover --session <path> --dry-run`);
	}
	return lines.join("\n");
}
