import test from "node:test";
import assert from "node:assert/strict";
import { LiveTailRetention, MAX_RETAINED_LIVE_TAILS } from "../extensions/goal-live-retention.ts";

const msg = (role: string, content: string, timestamp: number): any => ({ role, content, timestamp });
const contents = (messages: any[]): string[] => messages.map(message => message.content);

test("retained tails make each request a literal prefix of the next", () => {
	const retention = new LiveTailRetention();
	const base1 = [msg("user", "h", 1)];
	const first = retention.apply("s", base1, { state: "S", counters: "V1" });
	assert.deepEqual(contents(first.messages), ["h", "S", "V1"]);
	const base2 = [...base1, msg("assistant", "a", 2)];
	const second = retention.apply("s", base2, { state: "S", counters: "V2" });
	assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
	assert.deepEqual(contents(second.messages), ["h", "S", "V1", "a", "V2"]);
});

test("unchanged content across repeats and advances adds zero blocks", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	const fresh = { state: "S", counters: "V" };
	const first = retention.apply("s", base, fresh);
	const repeat = retention.apply("s", base, fresh);
	assert.deepEqual(repeat.messages, first.messages);
	const advanced = [...base, msg("assistant", "a", 2)];
	const third = retention.apply("s", advanced, fresh);
	assert.deepEqual(third.messages.slice(0, first.messages.length), first.messages);
	assert.equal(third.messages.length, first.messages.length + 1);
});

test("rewritten history resets once and never loses the live state", () => {
	const retention = new LiveTailRetention();
	retention.apply("s", [msg("user", "h", 1)], { state: "S", counters: "V1" });
	const compacted = [msg("user", "compacted summary", 10)];
	const next = retention.apply("s", compacted, { state: "S", counters: "V1" });
	assert.deepEqual(contents(next.messages), ["compacted summary", "S", "V1"]);
});

test("a changed policy block drops stale tails and starts a fresh prefix", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "S1", counters: "V1" });
	const next = retention.apply("s", base, { state: "S2", counters: "V2" });
	assert.deepEqual(contents(next.messages), ["h", "S2", "V2"]);
});

test("retained growth is bounded with one amortized reset per window", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	let previous: any[] | null = null;
	let breaks = 0;
	for (let i = 0; i < MAX_RETAINED_LIVE_TAILS + 8; i++) {
		const out = retention.apply("s", base, { state: "S", counters: `V${i}` });
		if (previous !== null && JSON.stringify(out.messages.slice(0, previous.length)) !== JSON.stringify(previous)) breaks++;
		previous = out.messages;
		assert.ok(out.messages.length <= base.length + MAX_RETAINED_LIVE_TAILS, "wire overhead stays within the retention window");
	}
	assert.equal(breaks, 1);
});

test("sessions are tracked independently", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("a", base, { state: "SA", counters: "VA" });
	const other = retention.apply("b", base, { state: "SB", counters: "VB" });
	assert.deepEqual(contents(other.messages), ["h", "SB", "VB"]);
	const again = retention.apply("a", base, { state: "SA", counters: "VA" });
	assert.deepEqual(contents(again.messages), ["h", "SA", "VA"]);
});

test("null fresh clears the session so the next request starts over", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "S", counters: "V" });
	const cleared = retention.apply("s", base, null);
	assert.deepEqual(cleared.messages, base);
	assert.deepEqual(cleared.transientContents, []);
	const advanced = [...base, msg("assistant", "a", 2)];
	const next = retention.apply("s", advanced, { state: "S", counters: "V" });
	assert.deepEqual(contents(next.messages), ["h", "a", "S", "V"]);
});

test("transient contents cover retained and fresh tails for marker relocation", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	retention.apply("s", base, { state: "S", counters: "V1" });
	const advanced = [...base, msg("assistant", "a", 2)];
	const next = retention.apply("s", advanced, { state: "S", counters: "V2" });
	assert.deepEqual(next.transientContents, ["S", "V1", "V2"]);
});

test("a retained tail never splits a tool-call batch when history diverges", () => {
	const retention = new LiveTailRetention();
	const user = msg("user", "Inspect", 1);
	const call = (ids: string[]): any => ({ role: "assistant", timestamp: 2, content: ids.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: id } })) });
	const result = (id: string): any => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "OK" }], timestamp: 3, isError: false });
	const fresh = { state: "S", counters: "V" };
	retention.apply("s", [user, call(["a"]), result("a")], fresh);
	// A different branch with the same shape must not inherit the old anchor.
	const out = retention.apply("s", [user, call(["b", "c"]), result("b"), result("c")], fresh).messages;
	const roles = out.map((m: any) => m.role);
	const firstResult = roles.indexOf("toolResult");
	assert.deepEqual(roles.slice(firstResult, firstResult + 2), ["toolResult", "toolResult"], "tool results stay adjacent");
	assert.deepEqual(roles.slice(-2), ["custom", "custom"], "live state rides at the tail");
});

test("an unchanged request near capacity keeps its prefix instead of resetting", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "h", 1)];
	let previous: any[] = [];
	for (let i = 0; i < MAX_RETAINED_LIVE_TAILS - 2; i++) previous = retention.apply("s", base, { state: "S", counters: `V${i}` }).messages;
	const repeat = retention.apply("s", base, { state: "S", counters: `V${MAX_RETAINED_LIVE_TAILS - 3}` }).messages;
	assert.deepEqual(repeat, previous, "a zero-growth request appends nothing and drops nothing");
});

for (const editInPlace of [false, true]) {
	test(`a middle-history ${editInPlace ? "in-place edit" : "replacement"} drops previously retained counters`, () => {
		const retention = new LiveTailRetention();
		const early = { role: "user", content: [{ type: "text", text: "early" }], timestamp: 1 };
		const base = [early, msg("user", "late", 2)];
		retention.apply("s", base, { state: "S", counters: "V1" });
		base.push(msg("assistant", "reply", 3));
		retention.apply("s", base, { state: "S", counters: "V2" });
		// Keep both anchor messages identical. Only earlier history changes.
		if (editInPlace) early.content[0]!.text = "edited";
		else base[0] = { ...early, content: [{ type: "text", text: "edited" }] };
		const next = retention.apply("s", base, { state: "S", counters: "V3" });
		assert.deepEqual(next.messages.slice(0, base.length), base, "no old tail remains between history messages");
		assert.deepEqual(contents(next.messages.slice(base.length)), ["S", "V3"]);
		assert.deepEqual(next.transientContents, ["S", "V3"], "old counters are gone, not merely replayed at the same anchor");
		assert.deepEqual(retention.apply("s", base, { state: "S", counters: "V3" }).messages, next.messages, "an unchanged retry does not reset or append");
	});
}

for (const resultShape of ["toolResult", "tool", "tool_result"] as const) {
	test(`a retained tail never splits an extended result batch (${resultShape})`, () => {
		const retention = new LiveTailRetention();
		const call = { role: "assistant", timestamp: 2, content: ["a", "b"].map(id => ({ type: "toolCall", id, name: "read", arguments: {} })) };
		const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", timestamp: 3, content: [{ type: "text", text: "OK" }], isError: false });
		const base = [msg("user", "Inspect", 1), call, result("a")];
		retention.apply("s", base, { state: "S", counters: "V1" });
		// No prior message changes: only the insertion-point guard can stop a
		// replay between these results when a filtered batch is extended.
		const extra = resultShape === "tool_result"
			? { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "OK" }], timestamp: 4 }
			: { ...result("b"), role: resultShape };
		const advanced = [...base, extra];
		const next = retention.apply("s", advanced, { state: "S", counters: "V2" });
		assert.deepEqual(next.messages.slice(0, advanced.length), advanced, "the result batch stays contiguous");
		assert.deepEqual(contents(next.messages.slice(advanced.length)), ["S", "V2"]);
		assert.deepEqual(next.transientContents, ["S", "V2"]);
	});
}

test("tails anchored on empty history reset once real history arrives", () => {
	const retention = new LiveTailRetention();
	const fresh = { state: "S", counters: "V" };
	const first = retention.apply("s", [], fresh).messages;
	assert.deepEqual(contents(first), ["S", "V"]);
	const out = retention.apply("s", [msg("user", "h", 1)], fresh).messages;
	assert.deepEqual(contents(out), ["h", "S", "V"], "fresh tails anchor at the tail, nothing lingers at the head");
});

test("eviction bounds provider metadata as well as retention", () => {
	const retention = new LiveTailRetention();
	for (let i = 0; i < 100; i++) retention.apply(`s${i}`, [{ role: "user", content: "start" }], { state: "S", counters: "1" });
	assert.equal(retention.contents("s0"), undefined);
	assert.deepEqual(retention.contents("s99"), ["S", "1"]);
});

test("a thousand changing requests bound retained counter bytes", () => {
	const retention = new LiveTailRetention();
	const base: unknown[] = [{ role: "user", content: "start" }];
	for (let i = 0; i < 1000; i++) {
		base.push({ role: "assistant", content: `turn ${i}` });
		const out = retention.apply("s", base, { state: "S", counters: `Snapshot ${i}: ${"x".repeat(180)}` });
		assert.ok(out.transientContents.filter(s => s !== "S").reduce((n, s) => n + Buffer.byteLength(s), 0) <= 4096);
		assert.equal((out.messages.at(-1) as { content: string }).content, `Snapshot ${i}: ${"x".repeat(180)}`);
	}
});


test("a delayed result resets earlier policy as well as the unsafe counter anchor", () => {
	const retention = new LiveTailRetention();
	const base: any[] = [msg("user", "inspect", 1)];
	retention.apply("s", base, {state: "S", counters: "V1"});
	base.push({role: "assistant", content: [{type: "toolCall", id: "a", name: "read", arguments: {}}]});
	retention.apply("s", base, {state: "S", counters: "V2"});
	base.push({role: "toolResult", toolCallId: "a", content: [{type: "text", text: "failed"}], isError: true});
	const out = retention.apply("s", base, {state: "S", counters: "V3"});
	assert.deepEqual(out.messages.slice(0, base.length), base);
	assert.deepEqual(contents(out.messages.slice(base.length)), ["S", "V3"]);
	assert.deepEqual(retention.contents("s"), ["S", "V3"]);
});

test("removing optional observations does not replay their old values", () => {
	const retention = new LiveTailRetention();
	const base = [msg("user", "inspect", 1)];
	retention.apply("s", base, {state: "S", counters: "obsolete occupancy"});
	const out = retention.apply("s", base, {state: "S"});
	assert.deepEqual(contents(out.messages), ["inspect", "S"]);
});

test("image and large tool-output edits invalidate hashes without changing stored history", () => {
	const retention = new LiveTailRetention();
	const image = {type: "image", data: "A".repeat(1024 * 1024), mimeType: "image/png"};
	const base: any[] = [{role: "user", content: [image]}, {role: "toolResult", toolCallId: "a", content: [{type: "text", text: "x".repeat(1024 * 1024)}]}];
	retention.apply("s", base, {state: "S", counters: "old"});
	image.data = "B" + image.data.slice(1);
	const out = retention.apply("s", base, {state: "S", counters: "new"});
	assert.deepEqual(out.messages.slice(0, base.length), base);
	assert.deepEqual(contents(out.messages.slice(base.length)), ["S", "new"]);
	assert.equal(base.length, 2);
});
