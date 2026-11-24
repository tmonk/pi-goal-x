/**
 * context:gate — CI-safe invariants over the composed-request baseline (PR D).
 *
 * Re-measures every fixture IN PROCESS and requires:
 *   1. deterministic equality with experiments/context/baseline-main.json;
 *   2. tool schemas present in every breakdown;
 *   3. every semantic field classified (counts object complete);
 *   4. provider-visible checkpoint markers individually bounded and stable;
 *   5. every registered fixture ID covered by the baseline.
 * No network, no child agents, no live model.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { captureOne } from "./capture-context.mjs";
import { FIXTURES } from "./fixtures.mjs";
import { measureContext, semanticCounts, serializeRequest } from "./measure-context.mjs";

function serializedRequestText(captured) {
	return serializeRequest(captured).total;
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const failures = [];

const baseline = JSON.parse(readFileSync(path.join(here, "baseline-main.json"), "utf8"));
const baselineById = new Map(baseline.fixtures.map((r) => [r.fixture, r]));

const expectedFixtureIds = Object.keys(FIXTURES).sort();
for (const id of expectedFixtureIds) {
	if (!baselineById.has(id)) failures.push(`fixture missing from baseline: ${id}`);
}
for (const id of baselineById.keys()) {
	if (!FIXTURES[id]) failures.push(`baseline contains unknown fixture: ${id}`);
}

let checked = 0;
for (const fixtureId of expectedFixtureIds) {
	const scenario = FIXTURES[fixtureId]();
	const captured = await captureOne(fixtureId);
	const breakdown = measureContext(captured);
	const semantic = semanticCounts({ ...captured, goal: scenario.goal });
	checked += 1;

	// 1. deterministic equality
	const baseRow = baselineById.get(fixtureId);
	if (!baseRow) continue;
	if (JSON.stringify(baseRow.breakdown) !== JSON.stringify(breakdown)) {
		failures.push(`${fixtureId}: breakdown drifted from committed baseline — update baseline-main.json WITH a spec rationale if intentional`);
	}
	if (JSON.stringify(baseRow.semantic) !== JSON.stringify(semantic)) {
		failures.push(`${fixtureId}: semantic counts drifted from committed baseline`);
	}

	// 2. tool schemas included
	if (!(breakdown.toolSchemaChars > 0)) failures.push(`${fixtureId}: no tool schema bytes measured`);

	// 3. semantic fields classified
	for (const key of ["objective", "verificationContract", "currentTask", "lifecyclePolicyThirdBlocker", "independentAuditor", "neverEditObjective"]) {
		if (!(key in semantic)) failures.push(`${fixtureId}: semantic field ${key} not classified`);
	}

 const names = captured.tools.map(t => t.name);
 // The tool list is the same in every phase; a draft only blocks goal tools at call time.
 if (scenario.draftPrompt && !["goal_questionnaire", "propose_goal_draft", "create_goal", "get_goal", "update_goal"].every(n => names.includes(n))) failures.push(`${fixtureId}: drafting must keep the fixed tool list`);
 if (fixtureId === "tasks-disabled" && names.some(n => n === "set_goal_tasks" || n === "update_goal_task")) failures.push(`${fixtureId}: disabled tools advertised`);
 if (["completion-audit", "audit-rejection-and-rework", "oracle-consultation"].includes(fixtureId) && !(breakdown.childRequestChars > 0)) failures.push(`${fixtureId}: child request not captured`);
 if (fixtureId === "post-compaction-turn" && !serializedRequestText(captured).includes("POST-COMPACTION RESYNC")) failures.push(`${fixtureId}: compaction hook was not exercised`);

	// 4. Retain bounded markers in place: deleting old ones breaks prefix caching.
	for (const message of captured.messages ?? []) {
		if (message.customType === "pi-goal-event" && (typeof message.content !== "string" || message.content.length > 160 || !message.content.endsWith('v="2"/>'))) {
			failures.push(`${fixtureId}: checkpoint is not a bounded v2 trigger`);
		}
	}
	if (captured.extensionSystem) failures.push(`${fixtureId}: goal state must not enter the system prefix`);
	const liveState = captured.messages.filter(m => m.customType === "pi-goal-live-context");
	const active = liveState[0]?.content?.includes("[PI GOAL ACTIVE goalId=");
	const expectedTails = active ? 2 : 1;
	if (liveState.length && (liveState.length !== expectedTails || liveState.some((m, i) => captured.messages.at(-expectedTails + i) !== m))) failures.push(`${fixtureId}: current policy and optional counters must occur once at the tail`);
	// The snapshot may start with the task list; the usage line always follows.
	if (active && !liveState[1]?.content?.includes("Goal snapshot:")) failures.push(`${fixtureId}: counters snapshot missing`);
	const liveText = liveState[0]?.content ?? "";

	// Required single-source markers on active-goal fixtures whose turn was
	// actually dispatched with an active block (a stale-checkpoint trigger
	// correctly aborts and injects GOAL STALE instead).
	const hasActiveBlock = /\[PI GOAL ACTIVE goalId=/.test(liveText);
	if (scenario.goal?.status === "active" && hasActiveBlock) {
		if (semantic.goalActiveMarker !== 1) failures.push(`${fixtureId}: [PI GOAL ACTIVE] block count ${semantic.goalActiveMarker} != 1`);
		// Long objectives are truncated to MAX_OBJECTIVE_BLOCK_CHARS — only the
		// head can appear. Fixtures use unique (non-periodic) text so a 300-char
		// head is an unambiguous needle.
		const fullObjective = scenario.goal.objective ?? "";
		const objectiveNeedle = fullObjective.slice(0, 300);
		const objectiveOccurrences = objectiveNeedle
			? (liveText.match(new RegExp(escapeRegExp(objectiveNeedle), "g")) ?? []).length
			: 0;
		if (objectiveOccurrences !== 1) failures.push(`${fixtureId}: objective appears ${objectiveOccurrences}x in composed request (must be exactly 1)`);
		if (scenario.goal?.verificationContract && fixtureId !== "get-goal-default-and-verbose" && semantic.verificationContract !== 1) {
			failures.push(`${fixtureId}: verification contract appears ${semantic.verificationContract}x (must be exactly 1)`);
		}
	}
}

console.log(`[context:gate] re-measured ${checked} fixtures against baseline-main.json (${baseline.fixtures.length} rows)`);
if (failures.length > 0) {
	console.error("[context:gate] FAIL:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("[context:gate] PASS");
