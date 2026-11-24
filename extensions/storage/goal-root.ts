import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSettingsSnapshot } from "../settings/resolve.ts";

export interface GoalStorageContext {
	cwd: string;
	/** Plain snapshot for deferred readers; never capture an ExtensionContext. */
	goalStorageRoot?: string;
	sessionManager?: { getSessionId(): string | undefined };
}

// Host contexts change between hooks; the session manager owns their lifetime.
const roots = new WeakMap<object, { id: string | undefined; cwd: string; root: string }>();

export function goalStorageRoot(ctx: GoalStorageContext): string {
	if (ctx.goalStorageRoot !== undefined) return ctx.goalStorageRoot;
	// Low-level cwd-only callers retain the original zero-settings-I/O contract.
	// Host sessions resolve configuration once; detached readers take a snapshot.
	return ctx.sessionManager ? configuredGoalRoot(ctx) : path.resolve(ctx.cwd, ".pi/goals");
}

function configuredGoalRoot(ctx: GoalStorageContext): string {
	if (ctx.goalStorageRoot !== undefined) return ctx.goalStorageRoot;
	const manager = ctx.sessionManager;
	const id = manager?.getSessionId();
	const key = manager ?? ctx;
	const pinned = roots.get(key);
	if (pinned && pinned.id === id && pinned.cwd === ctx.cwd) return pinned.root;
	const settings = loadSettingsSnapshot(ctx.cwd);
	const source = settings.provenance.get("goalsRoot")?.source;
	const invalid = settings.diagnostics.find(d => d.settingPath === "goalsRoot" && source !== "environment" && (d.scope === "project" || source !== "project"));
	if (invalid) throw new Error(`Invalid goalsRoot: ${invalid.message}`);
	const configured = settings.value.goalsRoot;
	let root = path.resolve(ctx.cwd, ".pi/goals");
	if (configured !== undefined) {
		const expanded = configured === "~" ? os.homedir() : configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured;
		if (!path.isAbsolute(expanded) || expanded.includes("\0")) throw new Error("goalsRoot / PI_GOAL_ROOT must be an absolute path or ~/path; reload after correcting it.");
		root = path.normalize(expanded);
		fs.mkdirSync(root, { recursive: true });
		if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Goal root is a symlink: ${root}`);
		root = fs.realpathSync(root);
		// Metadata lives inside an override without perturbing the pool's mtime.
		const metadata = path.join(root, ".metadata");
		fs.mkdirSync(metadata, { recursive: true });
		if (fs.lstatSync(metadata).isSymbolicLink()) throw new Error(`Goal metadata directory is a symlink: ${metadata}`);
	}
	roots.set(key, { id, cwd: ctx.cwd, root });
	return root;
}

export function goalStorageContext(ctx: GoalStorageContext): GoalStorageContext {
	return { cwd: ctx.cwd, goalStorageRoot: configuredGoalRoot(ctx) };
}

/** Logical paths stay compatible in saved goal files, independent of pool location. */
export function goalStoragePath(ctx: GoalStorageContext, logical: string): string {
	const relative = logical.replace(/\\/g, "/");
	if (relative !== ".pi/goals" && !relative.startsWith(".pi/goals/")) throw new Error(`Invalid goal storage path: ${logical}`);
	const root = goalStorageRoot(ctx);
	const result = path.resolve(root, relative.slice(".pi/goals".length + 1));
	const inside = path.relative(root, result);
	if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error(`Goal path escapes root: ${logical}`);
	return result;
}

export function isExternalGoalStorage(ctx: GoalStorageContext): boolean {
	return goalStorageRoot(ctx) !== path.resolve(ctx.cwd, ".pi/goals");
}

export function goalPoolSnapshotPath(ctx: GoalStorageContext): string {
	const root = goalStorageRoot(ctx);
	return root === path.resolve(ctx.cwd, ".pi/goals")
		? path.join(path.dirname(root), ".goals-pool-snapshot.json")
		: path.join(root, ".metadata", ".goals-pool-snapshot.json");
}

/** Validate managed ancestors on writes, without adding I/O to steady-state reads. */
export function ensureGoalStorageDirectory(ctx: GoalStorageContext, logical: string, verifyDefault = true): void {
	const root = goalStorageRoot(ctx);
	const target = goalStoragePath(ctx, logical);
	if (root === path.resolve(ctx.cwd, ".pi/goals")) {
		// Usually the folder is already there: one lstat answers both questions.
		try {
			const stat = fs.lstatSync(target);
			if (stat.isDirectory()) return;
			if (stat.isSymbolicLink() && verifyDefault) throw new Error(`Goal directory is a symlink: ${target}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		fs.mkdirSync(target, { recursive: true });
		if (verifyDefault && fs.lstatSync(target).isSymbolicLink()) throw new Error(`Goal directory is a symlink: ${target}`);
		return;
	}
	// An external pool removed during a session must not silently reappear.
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Goal root is a symlink: ${root}`);
	let dir = root;
	for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
		dir = path.join(dir, part);
		try { fs.mkdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Goal directory is a symlink: ${dir}`);
	}
}
