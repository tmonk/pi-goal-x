/**
 * Plain-text formatting for dashboard numbers: durations, token counts,
 * percentages and the budget summary. No TUI imports.
 */

import { formatDuration } from "../goal-display.ts";

/** Whole-number percentage of `done` out of `total`, clamped to 0-100. */
export function percentageOf(done: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

/** Compact elapsed duration, e.g. `12m47s` (shared formatter from goal-display). */
export function formatDashboardDuration(seconds: number): string {
	return formatDuration(seconds);
}

/** Audit header duration label from milliseconds. */
export function formatAuditElapsed(elapsedMs: number): string {
	return formatDuration(Math.floor(Math.max(0, elapsedMs) / 1000));
}

/**
 * Compact token count, e.g. `18.2K`, `2.5M`, `999`. Shared display label for
 * the dashboard header and budget rows.
 */
export function formatCompactTokens(value: number): string {
	const safe = Math.max(0, Math.floor(value));
	if (safe >= 1_000_000) return `${trimZero((safe / 1_000_000).toFixed(1))}M`;
	if (safe >= 1_000) return `${trimZero((safe / 1_000).toFixed(1))}K`;
	return String(safe);
}

function trimZero(value: string): string {
	return value.replace(/\.0$/, "");
}

/** Budget summary, e.g. `18.2K / 50K · 36%`. */
export function formatBudget(used: number, total: number): string {
	return `${formatCompactTokens(used)} / ${formatCompactTokens(total)} · ${percentageOf(used, total)}%`;
}
