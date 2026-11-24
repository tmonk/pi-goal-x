import * as fs from "node:fs";
import * as path from "node:path";
import { goalSettingsPath, invalidateGoalSettingsCache, parseSettingsLayer, type GoalSettingsLayer } from "../../extensions/goal-settings.ts";

/** Replace the project settings file with `settings`, as a user editing it by hand would. */
export function writeProjectSettings(cwd: string, settings: GoalSettingsLayer): void {
	const target = goalSettingsPath(cwd);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
	invalidateGoalSettingsCache();
}

/** Parse one settings object, throwing on unknown top-level keys so typos in tests fail loudly. */
export function parseSettings(raw: unknown): GoalSettingsLayer {
	const { layer, diagnostics } = parseSettingsLayer(raw, "project", "(inline)");
	const unknown = diagnostics
		.filter(d => d.code === "unknown_key" && d.settingPath && !d.settingPath.includes("."))
		.map(d => d.settingPath!);
	if (unknown.length > 0) throw new Error(`Unknown pi-goal-x-settings.json key(s): ${unknown.join(", ")}`);
	return layer;
}
