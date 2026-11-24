/**
 * Benchmark campaign registry.
 *
 * Each campaign is an isolated before/after cycle with its own spec dir
 * (AGENTS.md convention) and JSON baseline prefix, so re-baselining for a new
 * campaign never clobbers a previous campaign's committed artifacts.
 *
 *   campaign "extension-review-plan"  → specs/2026-08-04-extension-review-plan/
 *                                       baseline-before.json / baseline-after.json
 *   campaign "naf"                    → specs/2026-08-06-non-agent-flow-optimization/
 *                                       baseline-naf-before.json / baseline-naf-after.json
 *   campaign "speed"                  → specs/2026-11-24-runtime-speed/
 *                                       baseline-speed-before.json / baseline-speed-after.json
 *
 * Unknown campaign names fall back to a spec dir named after the campaign and
 * a matching JSON prefix.
 */

export const CAMPAIGNS = {
	"extension-review-plan": {
		specDir: "2026-08-04-extension-review-plan",
		jsonPrefix: "baseline-",
	},
	naf: {
		specDir: "2026-08-06-non-agent-flow-optimization",
		jsonPrefix: "baseline-naf-",
	},
	speed: {
		specDir: "2026-11-24-runtime-speed",
		jsonPrefix: "baseline-speed-",
	},
};

export function campaignConfig(name) {
	return CAMPAIGNS[name] ?? { specDir: name, jsonPrefix: `baseline-${name}-` };
}
