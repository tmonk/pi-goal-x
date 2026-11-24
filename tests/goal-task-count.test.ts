import test from "node:test";
import assert from "node:assert/strict";
import {countTaskSubtree} from "../extensions/goal-task-count.ts";
import {taskCompletionBlockWarning} from "../extensions/goal-policy.ts";
import {goalPromptParts} from "../extensions/prompts/goal-prompts.ts";
import {buildGoalAuditorPrompt} from "../extensions/goal-auditor.ts";
import type {GoalTask} from "../extensions/goal-record.ts";
import {stabilizationHarness} from "./support/stabilization-utils.ts";

test("nested counts agree with an independent flat reference for every display mode", () => {
	let seed = 0x110, id = 0;
	const random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed;};
	const tree = (depth = 0): GoalTask[] => Array.from({length: random() % 4}, () => ({id: `t${id++}`, title: "Task", status: (["pending", "complete", "skipped"] as const)[random() % 3]!, ...(depth < 3 ? {subtasks: tree(depth + 1)} : {})}));
	for (let n = 0; n < 300; n++) {
		const tasks = tree(), original = structuredClone(tasks), flat: GoalTask[] = [], queue = [...tasks];
		while (queue.length) {const task = queue.shift()!; flat.push(task); queue.push(...task.subtasks ?? []);}
		const complete = flat.filter(t => t.status === "complete").length;
		const skipped = flat.filter(t => t.status === "skipped").length;
		const pending = flat.filter(t => t.status === "pending");
		assert.equal(countTaskSubtree(tasks).pending, tasks.reduce((sum, task) => sum + countTaskSubtree([task]).pending, 0));
		for (const doneIncludesSkipped of [false, true]) for (const collectPending of [false, true]) {
			const counts = countTaskSubtree(tasks, {doneIncludesSkipped, collectPending});
			assert.equal(counts.total, flat.length);
			assert.equal(counts.complete, complete + (doneIncludesSkipped ? skipped : 0));
			assert.equal(counts.skipped, skipped);
			assert.equal(counts.pending, pending.length);
			assert.equal(counts.total, complete + counts.skipped + counts.pending);
			if (collectPending) assert.deepEqual(counts.pendingTasks!.map(t => t.id).sort(), pending.map(t => t.id).sort());
				else assert.equal(counts.pendingTasks, undefined);
		}
		assert.deepEqual(tasks, original);
	}
});

for (const pending of [false, true]) for (const approved of [false, true]) test(`registered completion: skipped subtree, pending=${pending}, auditor approves=${approved}`, async () => {
	let audits = 0;
	const h = stabilizationHarness(async () => {audits++; return {approved, output: approved ? "Evidence checked. <approved/>" : "Missing evidence. <disapproved/>"};});
	try {
		await h.start();
		const taskList = {tasks: [{id: "complete", title: "Verified work", status: "complete" as const, evidence: "tests pass"}, {id: "skip", title: "Out of scope", status: "skipped" as const, skipReason: "user excluded", subtasks: [{id: "child", title: "Nested work", status: pending ? "pending" as const : "skipped" as const, skipReason: "user excluded"}]}], blockCompletion: true, proposedAt: new Date().toISOString()};
		h.core.focus.updateFocused({...h.core.state.goal!, taskList}, h.ctx);
		assert.equal(!!taskCompletionBlockWarning(taskList), pending);
		// The task gate travels with the task list in the snapshot block.
		const parts = goalPromptParts(h.core.state.goal!);
		const prompt = `${parts.state}\n${parts.counters}`;
		const auditPrompt = buildGoalAuditorPrompt({goal: h.core.state.goal!, detailedSummary: "verified fixture"});
		assert.equal(/TASK GATE:/.test(prompt), pending);
		assert.equal(/TASK GATE:/.test(auditPrompt), pending);
		const result = await h.call("update_goal", {status: "complete"});
		assert.equal(audits, pending ? 0 : 1);
		assert.equal(h.core.state.goal?.status, !pending && approved ? "complete" : "active");
		if (!pending && approved) {
			assert.match(result.content[0].text, /skipped/);
			await h.event("turn_end", {message: {role: "assistant", stopReason: "stop"}});
			assert.equal(h.core.state.goal, null);
			assert.equal(h.ledger().filter(e => e.type === "goal_completed").length, 1);
		}
	} finally {await h.cleanup();}
});
