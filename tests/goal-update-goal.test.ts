import test from "node:test";
import assert from "node:assert/strict";
import {stabilizationHarness} from "./support/stabilization-utils.ts";
import {planUpdateGoal} from "../extensions/goal-tool-inputs.ts";
import { mutateSettingsLayer } from "../extensions/settings/mutate.ts";

export const recordedCompletion = {status: "complete", continuation: {kind: "ready"}, reason: "", suggested_action: "", attempted_actions: [], completion_summary: "…"};

test("the exact issue #115 object reaches the registered completion auditor", async () => {
	let called = 0;
	const h = stabilizationHarness(async args => {called++; assert.equal(args.completionSummary, "…"); return {approved: true, output: "Verified. <approved/>"};});
	try {
		await h.start();
		const result = await h.call("update_goal", recordedCompletion);
		assert.equal(result.isError, undefined);
		assert.equal(called, 1);
		assert.equal(h.core.state.goal?.status, "complete");
	} finally {await h.cleanup();}
});

test("structural conflicts preserve a dirty transaction, then a valid repair flushes it", async () => {
	let audited = 0;
	const h = stabilizationHarness(async () => {audited++; return {approved: true, output: "<approved/>"};});
	try {
		await h.start();
		await h.call("set_goal_tasks", {tasks: [{id: "a", title: "Task"}], block_completion: true});
		await h.event("turn_end", {message: {role: "assistant", stopReason: "stop"}});
		await h.event("turn_start");
		await h.call("update_goal_task", {task_id: "a", status: "complete", evidence: "tested"});
		const disk = h.disk(), events = h.ledger(), state = structuredClone(h.core.state.goal);
		const base = [{role: "user", content: "stable history", timestamp: 1}];
		const retained = await h.event("context_with_system", {messages: base});
		for (const params of [{status: "complete", reason: "real blocker"}, {continuation: {kind: "ready"}, completion_summary: "real completion"}, {status: "paused", continuation: {kind: "wait", reason: "external", deadline: "2099-01-01T00:00:00Z"}, reason: "pause"}]) {
			const response = await h.call("update_goal", params);
			assert.equal(response.isError, true);
			assert.equal(response.terminate, false);
			assert.match(response.content[0].text, /reason|completion_summary|continuation/);
			assert.equal(h.disk(), disk);
			assert.deepEqual(h.ledger(), events);
			assert.deepEqual(h.core.state.goal, state);
			assert.equal(h.core.goalService.isTurnBuffered(), true);
			assert.deepEqual(await h.event("context_with_system", {messages: base}), retained);
		}
		assert.equal(audited, 0);
		await h.call("update_goal", recordedCompletion);
		assert.equal(audited, 1);
		assert.equal(h.ledger().filter(e => e.type === "task_complete").length, 1);
	} finally {await h.cleanup();}
});

test("the pure planner accepts only fields belonging to one action and preserves its input", () => {
	const wait = {kind: "wait", reason: "External result", deadline: "2099-01-01T00:00:00Z", polling: {interval_seconds: 30, max_checks: 2}};
	const cases = [
		[{status: "complete", completion_summary: "verified"}, "complete"],
		[{status: "blocked", reason: "third recurrence", attempted_actions: [" ", "checked"]}, "blocked"],
		[{status: "paused", reason: "user requested", suggested_action: "review"}, "paused"],
		[{continuation: {kind: "ready"}}, "continuation"],
		[{continuation: wait}, "continuation"],
		] as const;
	for (const [input, action] of cases) {
		const filled = {reason: "", suggested_action: "  ", completion_summary: "", attempted_actions: [], ...input};
		const before = structuredClone(filled);
		const result = planUpdateGoal(filled);
		assert.equal(result.ok && result.plan.action, action);
		assert.deepEqual(filled, before);
	}
	for (const input of [null, [], {}, {reason: " "}, {status: "unknown"}, {status: "complete", reason: 1}, {status: "complete", continuation: {...wait}}, {status: "complete", continuation: {kind: "ready", reason: ""}}, {continuation: {kind: "ready"}, attempted_actions: ["real action"]}, {status: "blocked", reason: "why", completion_summary: "wrong field"}, {status: "paused", reason: "why", attempted_actions: ["wrong field"]}, {continuation: {...wait, polling: {interval_seconds: 0, max_checks: 1}}}]) assert.equal(planUpdateGoal(input).ok, false, JSON.stringify(input));
});

for (const strict of [false, true]) test(`filled wait preserves the actual scheduler boundary, strict=${strict}`, async () => {
	const h = stabilizationHarness();
	try {
		await h.start();
		h.core.focus.updateFocused({...h.core.state.goal!, autoContinue: true}, h.ctx);
		mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["strictExecutionContract"], value: strict}});
		const result = await h.call("update_goal", {continuation: {kind: "wait", reason: "producer", deadline: "2099-01-01T00:00:00Z"}, reason: " ", attempted_actions: [], suggested_action: "", completion_summary: ""});
		if (strict) {
			assert.equal(result.terminate, true);
			assert.equal(h.core.state.goal?.scheduler?.phase, "waiting");
			assert.equal(h.core.state.goal?.scheduler?.wait?.reason, "producer");
		} else {
			assert.match(result.content[0].text, /strictExecutionContract=true/);
			assert.notEqual(h.core.state.goal?.scheduler?.phase, "waiting");
		}
	} finally {await h.cleanup();}
});
