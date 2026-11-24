import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { GoalAuditMessages, filterGoalSessionContext, isDelegatedGoalSession } from "../extensions/goal-session-safety.ts";
import { registerGoalEvents, type GoalEventsCore } from "../extensions/goal-events.ts";

const audit = { role: "custom", customType: "pi-goal-audit-event", content: "Audit starting", display: true };
const checkpoint = { role: "custom", customType: "pi-goal-event", content: '<pi_goal_continuation goal_id="goal" kind="checkpoint" v="2"/>', display: false, details: { kind: "checkpoint", goalId: "goal" } };

test("audit messages wait for idle settlement, preserve order and never trigger turns", () => {
	let idle = false;
	let id = "session-a";
	const ctx = { isIdle: () => idle, sessionManager: { getSessionId: () => id } } as unknown as ExtensionContext;
	const sent: unknown[] = [];
	const pi = { sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }) } as unknown as ExtensionAPI;
	const queue = new GoalAuditMessages();
	queue.enqueue(ctx, audit);
	queue.enqueue(ctx, { ...audit, content: "Audit approved" });
	queue.flush(ctx, pi);
	assert.deepEqual(sent, []);
	idle = true;
	queue.flush(ctx, pi);
	queue.flush(ctx, pi);
	assert.deepEqual(sent, [audit, { ...audit, content: "Audit approved" }].map(message => ({ message, options: { triggerTurn: false } })));
	queue.enqueue(ctx, audit);
	id = "session-b";
	queue.flush(ctx, pi);
	assert.equal(sent.length, 2, "events cannot leak into another session");
	queue.enqueue(ctx, audit);
	queue.clear();
	queue.flush(ctx, pi);
	assert.equal(sent.length, 2, "session/tree/shutdown boundaries discard pending events");
});

const staleMessage = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx.";

for (const staleAt of ["sessionManager", "isIdle"] as const) {
	test(`audit flush skips stale ${staleAt} without dropping replacement messages`, () => {
		const queue = new GoalAuditMessages();
		const sent: unknown[] = [];
		const pi = { sendMessage: (message: unknown) => sent.push(message) } as unknown as ExtensionAPI;
		const context = (id: string) => ({ sessionManager: { getSessionId: () => id }, isIdle: () => true }) as unknown as ExtensionContext;
		const old = context("old");
		queue.enqueue(old, audit);
		const current = context("current");
		queue.enqueue(current, { ...audit, content: "Current audit" });
		Object.defineProperty(old, staleAt, { get: () => { throw new Error(staleMessage); } });
		assert.equal(queue.flush(old, pi), false);
		assert.deepEqual(sent, []);
		assert.equal(queue.flush(current, pi), true);
		assert.deepEqual(sent, [{ ...audit, content: "Current audit" }]);
		queue.flush(current, pi);
		assert.equal(sent.length, 1);
	});
}

test("stale settlement skips all scheduling work, including when the audit queue is empty", async () => {
	const handlers: Record<string, Function> = {};
	let settlements = 0;
	const core = {
		pi: { on: (name: string, handler: Function) => { handlers[name] = handler; } },
		auditMessages: new GoalAuditMessages(),
		scheduler: { settled: () => { settlements++; }, isDenied: () => false },
		interruption: { settled: () => {}, ignoreAbort: () => false, isHeld: () => false },
	} as unknown as GoalEventsCore;
	registerGoalEvents(core);
	const stale = { get sessionManager() { throw new Error(staleMessage); } } as unknown as ExtensionContext;
	await assert.doesNotReject(() => handlers.agent_settled!({}, stale));
	assert.equal(settlements, 0);
	const live = { sessionManager: { getSessionId: () => "live" }, isIdle: () => true };
	await handlers.agent_settled!({}, live);
	assert.equal(settlements, 1, "a valid callback still reaches scheduling");
});

test("audit flush keeps unexpected context and delivery errors observable", () => {
	const queue = new GoalAuditMessages();
	const failure = new Error("Unexpected session failure");
	const bad = { get sessionManager() { throw failure; } } as unknown as ExtensionContext;
	const pi = { sendMessage: () => { throw failure; } } as unknown as ExtensionAPI;
	assert.throws(() => queue.flush(bad, pi), error => error === failure);
	const live = { sessionManager: { getSessionId: () => "live" }, isIdle: () => true } as unknown as ExtensionContext;
	queue.enqueue(live, audit);
	assert.throws(() => queue.flush(live, pi), error => error === failure);
});

test("provider filtering preserves actual conversation and unrelated custom messages", () => {
	const assistant = { role: "assistant", content: [{ type: "toolCall", id: "a" }] };
	const tool = { role: "toolResult", toolCallId: "a", content: "result" };
	const other = { role: "custom", customType: "other-extension", content: "keep" };
	const ordinary = [assistant, tool, other, { role: "user", content: "keep", customType: "pi-goal-audit-event" }];
	const source = [assistant, audit, tool, checkpoint, ...ordinary.slice(2)];
	assert.deepEqual(filterGoalSessionContext(source), [assistant, tool, checkpoint, ...ordinary.slice(2)]);
	assert.deepEqual(filterGoalSessionContext(source, true), ordinary);
	assert.equal(filterGoalSessionContext(ordinary), null);
	assert.equal(source[1], audit, "history is not mutated");
});

test("child detection uses launch markers, not unrelated subagent settings", () => {
	for (const env of [{ PI_SUBAGENT_CHILD: "1" }, { PI_SUBAGENT_DEPTH: "1" }, { PI_SUBAGENT_DEPTH: "4" }]) assert.equal(isDelegatedGoalSession(env), true);
	for (const value of [undefined, "", "0", "-1", "NaN", "Infinity"]) assert.equal(isDelegatedGoalSession({ PI_SUBAGENT_DEPTH: value, PI_SUBAGENT_MAX_DEPTH: "4" }), false);
});

test("child installer registers only context filtering, without constructing goal state", async () => {
	const saved = process.env.PI_SUBAGENT_CHILD;
	const registrations: string[] = [];
	let context: any;
	try {
		process.env.PI_SUBAGENT_CHILD = "1";
		const pi = new Proxy({}, { get: (_target, key) => (...args: any[]) => {
			registrations.push(String(key));
			assert.equal(key, "on");
			assert.equal(args[0], "context_with_system");
			context = args[1];
		} });
		goalExtension(pi as ExtensionAPI);
		assert.deepEqual(registrations, ["on"]);
		assert.deepEqual(await context({ messages: [audit, checkpoint, { role: "user", content: "assignment" }] }), { messages: [{ role: "user", content: "assignment" }] });
	} finally {
		if (saved === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = saved;
	}
});
