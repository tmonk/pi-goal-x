/**
 * The goal text lives in request-only blocks that the extension replays at the
 * same places in every request. Whenever one of them goes missing, everything
 * after it is a prompt-cache miss. These tests walk the lifecycle events that
 * used to drop the blocks.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { stabilizationHarness } from "./support/stabilization-utils.ts";
import { createExtensionHarness } from "./support/extension-harness.ts";
import { tempDir } from "./support/fs.ts";
import { hasActiveDraft } from "../extensions/goal-drafting.ts";

/** What a new process starts with: nothing retained in memory. */
const forgetSharedRetention = () => { delete (globalThis as any)[Symbol.for("pi-goal-x.liveRetention")]; };
import { GOAL_ENDED_STATE, LiveTailRetention, MAX_RETAINED_LIVE_TAILS } from "../extensions/goal-live-retention.ts";

const ENDED = { state: GOAL_ENDED_STATE, interim: true, onlyIfSent: true };
const msg = (role: string, content: string, timestamp: number): any => ({ role, content, timestamp });
const contents = (messages: any[]): string[] => messages.map(message => message.content);

/** How many messages the two requests share from the start. */
function sharedPrefix(a: unknown[], b: unknown[]): number {
	let i = 0;
	while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i++;
	return i;
}

/** The request-only last block may change; everything before it must stay. */
function assertPrefixKept(before: unknown[], after: unknown[], what: string): void {
	assert.ok(sharedPrefix(before, after) >= before.length - 1, `${what}: the earlier request is no longer a prefix (${sharedPrefix(before, after)} of ${before.length} shared)`);
}

test("a goal that ends keeps the blocks already sent and says they are over", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const active = retention.apply("s", base, { state: "ACTIVE", counters: "TASKS", ephemeral: "usage 1", scope: "g1" });
	base.push(msg("assistant", "a", 2));
	const ended = retention.apply("s", base, ENDED);
	assertPrefixKept(active.messages, ended.messages, "goal ended");
	assert.ok(contents(ended.messages).some(text => text.includes("[PI GOAL ENDED]")));
	// Asking again adds nothing.
	base.push(msg("user", "next", 3));
	const again = retention.apply("s", base, ENDED);
	assert.equal(contents(again.messages).filter(text => text.includes("[PI GOAL ENDED]")).length, 1);
	assertPrefixKept(ended.messages, again.messages, "second request after the end");
});

test("nothing is retired when no goal text was ever sent", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	assert.deepEqual(retention.apply("s", base, ENDED).messages, base);
	assert.deepEqual(retention.contents("s"), undefined, "no session is kept for it");
});

test("a new goal after the end starts without a reset and sends its task list again", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "ONE", counters: "TASKS", scope: "g1" });
	base.push(msg("assistant", "a", 2));
	const ended = retention.apply("s", base, ENDED);
	base.push(msg("user", "new goal please", 3));
	const second = retention.apply("s", base, { state: "TWO", counters: "TASKS", scope: "g2" });
	assertPrefixKept(ended.messages, second.messages, "new goal after the end");
	assert.ok(contents(second.messages).some(text => text.includes("TWO")));
	assert.equal(contents(second.messages).filter(text => text === "TASKS").length, 2, "the ended note voided the old list, so the new one is sent");
});

test("a stale checkpoint or an unfocused pool does not reset the goal's blocks", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const active = retention.apply("s", base, { state: "ACTIVE", counters: "TASKS", scope: "g1" });
	base.push(msg("assistant", "a", 2));
	const stale = retention.apply("s", base, { state: "STALE", interim: true });
	assertPrefixKept(active.messages, stale.messages, "stale checkpoint");
	base.push(msg("assistant", "b", 3));
	const back = retention.apply("s", base, { state: "ACTIVE", counters: "TASKS", scope: "g1" });
	assertPrefixKept(stale.messages, back.messages, "back from the stale checkpoint");
});

test("a message the plain copy cannot hold does not reset the blocks on every request", () => {
	const retention = new LiveTailRetention();
	class Odd { text: string; constructor(text: string) { this.text = text; } }
	const odd = { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "ok" }], details: new Odd("x"), timestamp: 2 };
	const base: any[] = [msg("user", "h", 1), msg("assistant", "call", 1.5), odd];
	retention.apply("s", base, { state: "S", scope: "g" });
	for (let n = 0; n < 5; n++) {
		base.push(msg("assistant", `a${n}`, 10 + n));
		const next = retention.apply("s", base, { state: "S", scope: "g" });
		assert.equal(contents(next.messages).filter(text => text === "S").length, 1, "the policy block is still where it was");
		assert.equal(next.messages.findIndex(m => m.content === "S"), 3, "and it did not move");
	}
	// A change inside the odd message is still noticed.
	odd.details = new Odd("changed");
	const rewritten = retention.apply("s", base, { state: "S", scope: "g" });
	assert.equal(rewritten.messages.findIndex(m => m.content === "S"), base.length, "a real rewrite still starts over");
});

test("the busiest session is not the one evicted when others come and go", () => {
	const retention = new LiveTailRetention();
	const main = [msg("user", "h", 1)];
	retention.apply("main", main, { state: "S", scope: "g" });
	for (let n = 0; n < 40; n++) {
		retention.apply(`other-${n}`, [msg("user", "x", 1)], { state: "S", scope: "g" });
		main.push(msg("assistant", `a${n}`, 2 + n));
		const next = retention.apply("main", main, { state: "S", scope: "g" });
		assert.equal(next.messages.findIndex(m => m.content === "S"), 1, `main lost its blocks after ${n + 1} other sessions`);
	}
});

test("the request keeps its prefix when the goal completes", async () => {
	const h = stabilizationHarness();
	try {
		await h.start();
		const ask = async (messages: any[]) => (await h.event("context_with_system", { messages })).messages as any[];
		const base = [msg("user", "work on it", 1)];
		const first = await ask(base);
		assert.ok(contents(first).some(text => String(text).includes("PI GOAL ACTIVE")));
		base.push(msg("assistant", "done", 2));
		const second = await ask(base);
		assertPrefixKept(first, second, "ordinary turn");
		h.core.state.goal = { ...h.core.state.goal!, status: "complete" };
		base.push(msg("user", "thanks", 3));
		const third = await ask(base);
		assertPrefixKept(second, third, "goal completed");
		assert.ok(contents(third).some(text => String(text).includes("PI GOAL ENDED")));
		base.push(msg("assistant", "you are welcome", 4));
		assertPrefixKept(third, await ask(base), "turn after the goal ended");
	} finally {
		await h.cleanup();
	}
});

test("a host that gives no session id still gets retained blocks", async () => {
	const h = stabilizationHarness();
	try {
		h.ctx.sessionManager.getSessionId = () => undefined;
		await h.start();
		const ask = async (messages: any[]) => (await h.event("context_with_system", { messages })).messages as any[];
		const base = [msg("user", "work on it", 1)];
		const first = await ask(base);
		base.push(msg("assistant", "step", 2));
		const second = await ask(base);
		assertPrefixKept(first, second, "no session id");
		assert.equal(contents(second).filter(text => String(text).includes("PI GOAL ACTIVE")).length, 1);
	} finally {
		await h.cleanup();
	}
});

test("the retention bound still applies after a goal ended", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "ONE", counters: "T0", scope: "g" });
	retention.apply("s", base, ENDED);
	for (let n = 1; n <= MAX_RETAINED_LIVE_TAILS + 2; n++) {
		base.push(msg("assistant", `a${n}`, 1 + n));
		retention.apply("s", base, { state: "ONE", counters: `T${n}`, scope: "g" });
	}
	const last = retention.apply("s", base, { state: "ONE", counters: `T${MAX_RETAINED_LIVE_TAILS + 2}`, scope: "g" });
	assert.ok(last.messages.length < base.length + MAX_RETAINED_LIVE_TAILS + 3);
});

test("starting a draft after a goal ended keeps the request prefix", async () => {
	const cwd = tempDir("goal-cache-draft-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createExtensionHarness({ cwd, hasUI: true, sessionId: "cache-draft", custom: "dialog" });
		await h.sessionStart();
		await h.commands.get("goal-direct")!.handler("First objective", h.ctx);
		const ask = async (messages: any[]) => (await h.emit("context_with_system", { messages })).messages as any[];
		const base = [msg("user", "work on it", 1)];
		const active = await ask(base);
		assert.ok(contents(active).some(text => String(text).includes("PI GOAL ACTIVE")));
		base.push(msg("assistant", "done", 2));
		h.core.state.goal = { ...h.core.state.goal!, status: "complete" };
		const ended = await ask(base);
		assertPrefixKept(active, ended, "goal completed");
		await h.commands.get("goal")!.handler("A new objective", h.ctx);
		assert.ok(hasActiveDraft(h.core), "the draft is open");
		base.push(msg("user", "/goal A new objective", 3));
		const drafting = await ask(base);
		assertPrefixKept(ended, drafting, "draft opened after the goal ended");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a reload keeps the retained blocks, and so does a restart that finds them saved with the session", async () => {
	const cwd = tempDir("goal-cache-reload-");
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const first = createExtensionHarness({ cwd, hasUI: false, sessionId: "reload-session" });
		await first.sessionStart();
		await first.callTool("create_goal", { objective: "Survive a reload" });
		const ask = async (h: typeof first, messages: any[]) => (await h.emit("context_with_system", { messages })).messages as any[];
		const base = [msg("user", "work on it", 1), msg("assistant", "started", 2)];
		const before = await ask(first, base);
		assert.ok(contents(before).some(text => String(text).includes("PI GOAL ACTIVE")));
		assert.ok(first.entries.some(entry => entry.customType === "pi-goal-live-tails"), "the blocks were saved with the session");
		base.push(msg("assistant", "more", 3));
		const options = { cwd, hasUI: false, sessionId: "reload-session", sessionEntries: () => first.entries as any };

		// The same conversation under a new extension instance, as after /reload.
		const reloaded = createExtensionHarness(options);
		await reloaded.sessionStart("reload");
		const afterReload = await ask(reloaded, base);
		assert.equal(afterReload.filter(m => String(m.content).includes("PI GOAL ACTIVE")).length, 1, "the goal is focused again");
		assertPrefixKept(before, afterReload, "reload");

		// A new process: nothing in memory, so the blocks come from the session entries.
		forgetSharedRetention();
		const restarted = createExtensionHarness(options);
		await restarted.sessionStart("resume");
		const afterRestart = await ask(restarted, base);
		assertPrefixKept(before, afterRestart, "restart");
		assert.equal(afterRestart.filter(m => String(m.content).startsWith("[PI GOAL")).length, 1, "the saved block was reused, not sent again");

		// Another conversation under the same id must not pick the blocks up.
		forgetSharedRetention();
		const other = createExtensionHarness(options);
		await other.sessionStart("resume");
		const rewritten = [msg("user", "something else", 1), msg("assistant", "started", 2), msg("assistant", "more", 3)];
		const clean = await ask(other, rewritten);
		assert.equal(clean.findIndex(m => String(m.content).includes("[PI GOAL ")), rewritten.length, "changed history starts clean");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("pause and resume cycles point back to the policy instead of repeating it, so they never hit the block limit", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	let previous = retention.apply("s", base, { state: "[PI GOAL ACTIVE goalId=g]\nBIG POLICY", counters: "TASKS", scope: "g" }).messages;
	for (let cycle = 0; cycle < 40; cycle++) {
		for (const state of ["[PI GOAL PAUSED goalId=g]\nPAUSED POLICY", "[PI GOAL ACTIVE goalId=g]\nBIG POLICY"]) {
			base.push(msg("assistant", `a${cycle}`, 2 + cycle));
			const next = retention.apply("s", base, { state, counters: "TASKS", scope: "g" }).messages;
			assertPrefixKept(previous, next, `cycle ${cycle}`);
			previous = next;
		}
	}
	const text = contents(previous).join("\n");
	assert.equal(text.split("BIG POLICY").length - 1, 1, "the full policy was sent once");
	assert.equal(text.split("PAUSED POLICY").length - 1, 1, "and so was the paused one");
	assert.match(text, /\[PI GOAL RESTORED\] The goal policy above that begins "\[PI GOAL ACTIVE goalId=g\]" is in force again/);
	assert.equal(contents(previous).filter(c => String(c).includes("TASKS")).length, 1, "the task list was not repeated either");
});
