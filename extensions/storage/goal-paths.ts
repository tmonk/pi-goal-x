/**
 * Goal file locations: the logical directories, the file-name patterns and the
 * checks that keep a stored path inside the directory it claims to live in.
 * Pure path logic; nothing here touches the disk.
 */
import * as path from "node:path";
import { goalStoragePath, type GoalStorageContext } from "./goal-root.ts";
import { cloneGoal, normalizeRelPath, nowIso, safeIdPart, type GoalRecord } from "../goal-record.ts";

export type GoalFileContext = GoalStorageContext;

export const GOALS_DIR = ".pi/goals";
export const ARCHIVED_GOALS_DIR = ".pi/goals/archived";

const ACTIVE_NAME = /^active_goal_.*\.md$/;
const ARCHIVED_NAME = /^goal_.*\.md$/;

/** True for the base name of an active goal file. */
export function isActiveGoalFileName(name: string): boolean {
	return ACTIVE_NAME.test(name);
}

function timestampForFile(iso = nowIso()): string {
	const date = new Date(iso);
	const safe = Number.isFinite(date.getTime()) ? date : new Date();
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return [
		safe.getFullYear(),
		pad(safe.getMonth() + 1),
		pad(safe.getDate()),
		pad(safe.getHours()),
		pad(safe.getMinutes()),
		pad(safe.getSeconds()),
		pad(Math.floor(safe.getMilliseconds() / 10)),
	].join("");
}

/** A direct child of `rootRel` that stays inside it once resolved. */
function isSafeRelativeUnder(ctx: GoalFileContext, rootRel: string, relPath: string | undefined): relPath is string {
	if (!relPath || path.isAbsolute(relPath) || relPath.includes("\0")) return false;
	const normalized = normalizeRelPath(relPath);
	const parent = normalizeRelPath(path.posix.dirname(normalized));
	if (parent !== normalizeRelPath(rootRel)) return false;
	const root = goalStoragePath(ctx, rootRel);
	const absolutePath = goalStoragePath(ctx, normalized);
	const relative = path.relative(root, absolutePath);
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isSafeActivePath(ctx: GoalFileContext, relPath: string | undefined): relPath is string {
	return Boolean(
		isSafeRelativeUnder(ctx, GOALS_DIR, relPath)
			&& ACTIVE_NAME.test(path.posix.basename(normalizeRelPath(relPath))),
	);
}

function isSafeArchivedPath(ctx: GoalFileContext, relPath: string | undefined): relPath is string {
	return Boolean(
		isSafeRelativeUnder(ctx, ARCHIVED_GOALS_DIR, relPath)
			&& ARCHIVED_NAME.test(path.posix.basename(normalizeRelPath(relPath))),
	);
}

/** Drop stored paths that point outside the goal directories. */
export function sanitizeGoalPaths(ctx: GoalFileContext, goal: GoalRecord): GoalRecord {
	const next = cloneGoal(goal);
	if (!isSafeActivePath(ctx, next.activePath)) delete next.activePath;
	if (!isSafeArchivedPath(ctx, next.archivedPath)) delete next.archivedPath;
	return next;
}

export function resolveGoalPath(ctx: GoalFileContext, rootRel: string, relPath: string): string {
	const root = goalStoragePath(ctx, rootRel);
	const absolutePath = goalStoragePath(ctx, normalizeRelPath(relPath));
	const relative = path.relative(root, absolutePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Goal path escapes ${rootRel}: ${relPath}`);
	return absolutePath;
}

export function activePathForGoal(ctx: GoalFileContext, goal: GoalRecord): string {
	return isSafeActivePath(ctx, goal.activePath)
		? goal.activePath
		: `${GOALS_DIR}/active_goal_${timestampForFile(goal.createdAt)}_${safeIdPart(goal.id)}.md`;
}

export function archivedPathForGoal(ctx: GoalFileContext, goal: GoalRecord): string {
	return isSafeArchivedPath(ctx, goal.archivedPath)
		? goal.archivedPath
		: `${ARCHIVED_GOALS_DIR}/goal_${timestampForFile(goal.updatedAt)}_${safeIdPart(goal.id)}.md`;
}
