/**
 * Conflict-safe settings writes: fresh re-read under a filesystem path lock,
 * structured-clone apply, atomic same-dir temp+rename write with mode
 * preservation. Concurrent processes never lose each other's keys.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "../storage/atomic-rename.ts";
import { acquireFileLock, type FileLock } from "../storage/file-lock.ts";
import { goalGlobalSettingsPath, goalSettingsPath, invalidateSettingsCachePath, readSettingsLayerFresh } from "./files.ts";
import { loadSettingsSnapshot, type SettingsSnapshot } from "./resolve.ts";
import { parseSettingsLayer, type GoalSettingsLayer, type SettingsDiagnostic, type SettingsScope } from "./schema.ts";

export type SettingsMutation =
	| { op: "set"; path: readonly string[]; value: unknown }
	| { op: "unset"; path: readonly string[] };

interface MutateSettingsInput {
	scope: SettingsScope;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	mutation: SettingsMutation;
	/** Optional UI validation, run against the fresh layer while its write lock is held. */
	validate?: (next: GoalSettingsLayer, current: GoalSettingsLayer) => void;
}

export class SettingsMutationError extends Error {
	readonly diagnostics?: SettingsDiagnostic[];

	constructor(message: string, diagnostics?: SettingsDiagnostic[]) {
		super(message);
		this.name = "SettingsMutationError";
		this.diagnostics = diagnostics;
	}
}

function acquireSettingsLock(target: string): FileLock {
	const lockPath = `${target}.lock`;
	return acquireFileLock(lockPath, {
		attempts: 200,
		retryMs: 5,
		staleTtlMs: 30_000,
		timeoutError: () => new SettingsMutationError(`Timed out acquiring the settings lock at ${lockPath}. Another writer may hold it.`),
	});
}

function refuseSymlinkTarget(target: string): void {
	try {
		if (fs.lstatSync(target).isSymbolicLink()) {
			throw new SettingsMutationError(`refusing symlink settings target: ${target}`);
		}
	} catch (err) {
		if (err instanceof SettingsMutationError) throw err;
		// Target does not exist yet — fine.
	}
}

function writeSettingsJson(target: string, value: unknown): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	refuseSymlinkTarget(target);
	writeFileAtomicSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, durable: true });
}

function applyPathMutation(layer: GoalSettingsLayer, mutation: SettingsMutation): void {
	if (mutation.path.length === 0) throw new SettingsMutationError("empty settings path");
	let container: Record<string, unknown> = layer as unknown as Record<string, unknown>;
	for (let i = 0; i < mutation.path.length - 1; i += 1) {
		const key = mutation.path[i]!;
		const next = container[key];
		if (!next || typeof next !== "object") {
			if (mutation.op === "unset") return; // nothing to unset
			container[key] = {};
		}
		container = container[key] as Record<string, unknown>;
	}
	const last = mutation.path[mutation.path.length - 1]!;
	// thinkingLevel/thinking_level are accepted aliases on read; writes operate
	// on BOTH spellings so unset clears hand-edited variants too.
	if (last === "thinkingLevel" || last === "thinking_level") {
		if (mutation.op === "set") container.thinkingLevel = mutation.value;
		else {
			delete container.thinkingLevel;
			delete container.thinking_level;
		}
		return;
	}
	if (mutation.op === "set") container[last] = mutation.value;
	else delete container[last];
}

/** Canonicalize the persisted spelling of aliased keys before writing. */
function canonicalizeAliases(layer: Record<string, unknown>): void {
	if (layer.thinkingLevel !== undefined) {
		layer.thinking_level = layer.thinkingLevel;
		delete layer.thinkingLevel;
	}
}

function pruneEmptyObjects(value: unknown): void {
	for (const key of Object.keys(value as Record<string, unknown>)) {
		const child = (value as Record<string, unknown>)[key];
		if (child && typeof child === "object" && !Array.isArray(child)) {
			pruneEmptyObjects(child);
			if (Object.keys(child as Record<string, unknown>).length === 0) delete (value as Record<string, unknown>)[key];
		}
	}
}

/**
 * Apply a scoped mutation under the target's path lock and return a fresh
 * snapshot. Refuses to overwrite an invalid layer; writes atomically;
 * invalidates only the affected cache entry.
 */
export function mutateSettingsLayer(input: MutateSettingsInput): SettingsSnapshot {
	const env = input.env ?? process.env;
	const target = input.scope === "global"
		? goalGlobalSettingsPath(env)
		: goalSettingsPath(input.cwd, env);
	const lock = acquireSettingsLock(target);

	try {
		const current = readSettingsLayerFresh(target, input.scope);
		if (current.status === "invalid") {
			throw new SettingsMutationError(
				`Refusing to overwrite invalid ${input.scope} settings at ${target}`,
				current.diagnostics,
			);
		}

		const next = structuredClone(current.layer) as Record<string, unknown>;
		applyPathMutation(next as unknown as GoalSettingsLayer, input.mutation);
		pruneEmptyObjects(next);
		canonicalizeAliases(next);

		const reparsed = parseSettingsLayer(JSON.parse(JSON.stringify(next)), input.scope, target);
		if (reparsed.diagnostics.some((d) => d.code === "invalid_value" || d.code === "invalid_nested_key")) {
			throw new SettingsMutationError(`Mutation produced invalid ${input.scope} settings`, reparsed.diagnostics);
		}
		input.validate?.(reparsed.layer, current.layer);

		writeSettingsJson(target, next);
		invalidateSettingsCachePath(target);
		return loadSettingsSnapshot(input.cwd, env);
	} finally {
		lock.release();
	}
}
