import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { GoalAuditMessages, filterGoalSessionContext, isDelegatedGoalSession, registerContextTransform } from "../extensions/goal-session-safety.ts";

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
	const handlers: Record<string, any> = {};
	try {
		process.env.PI_SUBAGENT_CHILD = "1";
		const pi = new Proxy({}, { get: (_target, key) => (...args: any[]) => {
			registrations.push(String(key) + ":" + args[0]);
			handlers[args[0]] = args[1];
		} });
		goalExtension(pi as ExtensionAPI);
		assert.deepEqual(registrations, ["on:context", "on:context_with_system"]);
		assert.deepEqual(await handlers.context({ messages: [audit, checkpoint, { role: "user", content: "assignment" }] }), { messages: [{ role: "user", content: "assignment" }] });
	} finally {
		if (saved === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = saved;
	}
});

test("context transforms run once per request, in context_with_system once Pi dispatches it", async () => {
	const handlers: Record<string, any> = {};
	const pi = { on: (name: string, handler: any) => { handlers[name] = handler; } };
	const tail = { role: "custom", content: "state" };
	registerContextTransform(pi as unknown as ExtensionAPI, messages => [...messages, tail]);
	const system = { role: "system", content: "" };
	const user = { role: "user", content: "one" };
	// Pi runs context, then context_with_system. Support is unknown until the first dispatch.
	assert.deepEqual(await handlers.context({ messages: [user] }), { messages: [user, tail] });
	assert.equal(await handlers.context_with_system({ messages: [system, user, tail] }), undefined);
	// Once known, an unchanged context keeps Pi's system messages where they are.
	assert.equal(await handlers.context({ messages: [user] }), undefined);
	assert.deepEqual(await handlers.context_with_system({ messages: [system, user] }), { messages: [system, user, tail] });
});
