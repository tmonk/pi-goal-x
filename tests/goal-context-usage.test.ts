import test from "node:test";
import assert from "node:assert/strict";
import { contextUsageLine, modelBudgetLine } from "../extensions/goal-accounting.ts";
import { createGoal } from "../extensions/goal-record.ts";
import { goalPromptParts } from "../extensions/prompts/goal-prompts.ts";
import { LiveTailRetention } from "../extensions/goal-live-retention.ts";
import {stabilizationHarness, deferred} from "./support/stabilization-utils.ts";
import { effectiveSettingsReport, loadGoalSettings } from "../extensions/settings/resolve.ts";
import { mutateSettingsLayer } from "../extensions/settings/mutate.ts";
import {readFileSync, existsSync} from "node:fs";
import path from "node:path";

test("context occupancy never falls back to cumulative usage or invented zero", () => {
	for (const usage of [undefined, { tokens: null, contextWindow: 200000 }, { tokens: NaN, contextWindow: 200000 }, { tokens: 10, contextWindow: 0 }]) assert.equal(contextUsageLine(usage), "Context snapshot: unavailable");
	assert.equal(contextUsageLine({ tokens: 100000, contextWindow: 250000 }), "Context snapshot: 100000/250000 tokens (40%)");
	assert.equal(contextUsageLine({ tokens: 0, contextWindow: 250000 }), "Context snapshot: 0/250000 tokens (0%)");
});

test("context display defaults off and explicit true preserves the existing counter text", () => {
	const goal = createGoal({objective: "Continue work", autoContinue: true, sisyphus: false});
	for (const usage of [undefined, {tokens: 0, contextWindow: 1000}, {tokens: 20, contextWindow: 1000}]) {
		for (const maxAutonomousRuns of [undefined, 10]) for (const showAutonomousRuns of [false, true]) {
			const enabled = goalPromptParts(goal, {showContextUsage: true, maxAutonomousRuns, showAutonomousRuns}, usage);
			assert.match(enabled.counters, /Context snapshot:/);
			for (const value of [undefined, false]) {
				const hidden = goalPromptParts(goal, {showContextUsage: value, maxAutonomousRuns, showAutonomousRuns}, usage);
				assert.equal(hidden.state, enabled.state);
				assert.equal(hidden.counters, enabled.counters.replace(`\n${contextUsageLine(usage)}`, ""));
				assert.doesNotMatch(hidden.counters, /Context snapshot:|\n\n/);
			}
		}
	}
	assert.doesNotMatch(goalPromptParts(goal).counters, /Context snapshot:/);
});

for (const mode of ["ordinary", "audit", "wait"]) test(`registered context toggles preserve the prefix and pending ${mode} state`, async () => {
	const pending = deferred<any>(), started = deferred<any>();
	const h = stabilizationHarness(async () => {started.resolve(null); return pending.promise;});
	let completion: Promise<any> | undefined;
	try {
		await h.start();
		if (mode === "audit") {completion = h.call("update_goal", {status: "complete"}); await started.promise;}
		if (mode === "wait") {
			mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["strictExecutionContract"], value: true}});
			h.core.focus.updateFocused({...h.core.state.goal!, autoContinue: true}, h.ctx);
			h.core.scheduler.begin(h.ctx);
			assert.equal(h.core.scheduler.declare(h.ctx, {kind: "wait", reason: "External producer", deadline: new Date(Date.now() + 60000).toISOString()}).terminate, true);
			assert.equal(h.core.state.goal?.scheduler?.phase, "waiting");
		}
		const audit = h.core.state.activeAudit, animation = h.core.view.auditAnimationTimer;
		const base = [{role: "user", content: "history", timestamp: 1}];
		const capture = async () => (await h.event("context_with_system", {messages: base})).messages;
		const first = await capture();
		assert.doesNotMatch(JSON.stringify(first), /Context snapshot:/);
		h.ctx.getContextUsage = () => ({tokens: 900, contextWindow: 1000});
		assert.deepEqual(await capture(), first);
		const installs = h.toolInstalls, goal = structuredClone(h.core.state.goal), ledger = h.ledger();
		let previous = first;
		for (const value of [true, false, true]) {
			mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["showContextUsage"], value}});
			base.push({role: "assistant", content: "work", timestamp: base.length + 1});
			const next = await capture();
			assert.deepEqual(next.slice(0, previous.length), previous);
			assert.equal(next.at(-1).content.includes("Context snapshot:"), value);
			assert.deepEqual(await capture(), next);
			previous = next;
		}
		assert.equal(h.toolInstalls, installs);
		assert.deepEqual(h.core.state.goal, goal);
		assert.deepEqual(h.ledger(), ledger);
		assert.equal(h.core.state.activeAudit, audit);
		assert.equal(h.core.view.auditAnimationTimer, animation);
		assert.equal(audit?.controller.signal.aborted ?? false, false);
		assert.equal(h.sent.length, 0);
	} finally {pending.resolve({approved: false, output: "More verification needed."}); await completion; await h.cleanup();}
});

test("display on/off preserves registered accounting, budgets and compaction state", async () => {
	const outcomes = [];
	for (const showContextUsage of [false, true]) {
		const h = stabilizationHarness();
		try {
			mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["showContextUsage"], value: showContextUsage}});
			await h.start();
			h.core.focus.updateFocused({...h.core.state.goal!, tokenBudget: 15}, h.ctx);
			await h.event("before_agent_start", {prompt: "work", systemPrompt: "stable", systemPromptOptions: {}});
			await h.event("agent_start"); await h.event("turn_start");
			await h.event("context_with_system", {messages: [{role: "user", content: "work", timestamp: 1}]});
			await h.event("turn_end", {message: {role: "assistant", stopReason: "stop", usage: {input: 12, output: 7}}});
			await h.event("session_before_compact"); await h.event("session_compact");
			const goal = h.core.state.goal!;
			assert.equal(goal.status, "budget_limited");
			assert.equal(goal.usage.tokensUsed, 19);
			outcomes.push({status: goal.status, tokens: goal.usage.tokensUsed, runs: goal.scheduler?.used, budgetEvents: h.ledger().filter(e => e.type === "goal_budget_limited").length, reminder: h.core.runtime.isPostCompactReminderPending()});
		} finally {await h.cleanup();}
	}
	assert.deepEqual(outcomes[0], outcomes[1]);
});

test("the registered settings menu edits and resets context display in both scopes without runtime side effects", async () => {
	const h = stabilizationHarness(), previousGlobal = process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
	const global = path.join(h.cwd, "global.json");
	process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = global;
	const reports: string[] = [], saved: any[] = [];
	try {
		h.ctx.hasUI = true;
		const choices = ["row", "Set project override to true", "scope", "row", "Set global override to true", "scope", "row", "Set project override to false", "row", "Use inherited value", "scope", "row", "Use default (delete global override)", "Done"];
		h.ctx.ui.select = async (title: string, options: string[]) => {
			if (title === "Goal settings") {
				reports.push(effectiveSettingsReport(h.cwd).join("\n"));
				saved.push(JSON.parse(readFileSync(path.join(h.cwd, ".pi/pi-goal-x-settings.json"), "utf8")));
			}
			const next = choices.shift();
			if (next === "row") return options.find(option => option.startsWith("  show context usage line:"));
			if (next === "scope") return options.find(option => option.startsWith("Scope:"));
			assert.ok(next && options.includes(next));
			return next;
		};
		await h.start();
		const installs = h.toolInstalls, before = structuredClone(h.core.state.goal);
		await h.commands.get("goal-settings").handler("", h.ctx);
		assert.equal(choices.length, 0);
		assert.ok(saved.some(settings => settings.showContextUsage === false));
		assert.ok(reports.some(report => report.includes("show context usage line: true (global)")));
		assert.ok(reports.some(report => report.includes("show context usage line: false (project)")));
		assert.equal(loadGoalSettings(h.cwd).showContextUsage, false);
		assert.equal(JSON.parse(readFileSync(path.join(h.cwd, ".pi/pi-goal-x-settings.json"), "utf8")).showContextUsage, undefined);
		assert.ok(!existsSync(global) || JSON.parse(readFileSync(global, "utf8")).showContextUsage === undefined);
		assert.equal(h.toolInstalls, installs);
		assert.deepEqual(h.core.state.goal, before);
		assert.equal(h.sent.length, 0);
	} finally {
		if (previousGlobal === undefined) delete process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
			else process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = previousGlobal;
		await h.cleanup();
	}
});

test("changing and removing budget or run limits clears historical policy", () => {
	const goal = createGoal({ objective: "Continue work", autoContinue: true, sisyphus: false });
	goal.tokenBudget = 100;
	goal.usage.tokensUsed = 20;
	const retention = new LiveTailRetention();
	const base = [{ role: "user", content: "start" }];
	retention.apply("s", base, goalPromptParts(goal, { maxAutonomousRuns: 10 }));
	delete goal.tokenBudget;
	const parts = goalPromptParts(goal, {}, { tokens: 20, contextWindow: 1000 });
	const out = retention.apply("s", [...base, { role: "assistant", content: "work" }], parts);
	assert.equal(out.transientContents.length, 2);
	assert.match(out.transientContents[0]!, /Limits: lifetime tokens=none; runs=unlimited/);
	assert.doesNotMatch(out.transientContents.join("\n"), /tokens=100|runs=10/);
	assert.match(modelBudgetLine({ tokenBudget: 1, usage: { tokensUsed: 2 } })!, /spending cap, not context capacity/);
});
