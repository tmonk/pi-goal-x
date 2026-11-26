import test from "node:test";
import assert from "node:assert/strict";
import { CacheStats } from "../extensions/goal-cache-stats.ts";

const usage = (input: number, cacheRead: number, cacheWrite = 0) => ({ input, cacheRead, cacheWrite, output: 10 });

test("cache stats: nothing to say before a request is large enough to cache", () => {
	const stats = new CacheStats();
	assert.equal(stats.record(usage(500, 0)), undefined);
	assert.equal(stats.line(), undefined);
});

test("cache stats: reports the overall and last hit rate", () => {
	const stats = new CacheStats();
	stats.record(usage(5000, 0, 5000));
	stats.record(usage(500, 9500));
	const line = stats.line() ?? "";
	assert.match(line, /48%/);
	assert.match(line, /2 requests/);
	assert.match(line, /last request 95%/);
});

test("cache stats: warns once when hits drop to nearly zero twice in a row after working well", () => {
	const stats = new CacheStats();
	assert.equal(stats.record(usage(500, 9500)), undefined);
	assert.equal(stats.record(usage(10000, 0)), undefined, "one bad request is not enough");
	assert.match(stats.record(usage(10000, 0)) ?? "", /fell to 0%/);
	assert.equal(stats.record(usage(10000, 0)), undefined, "warns once");
});

test("cache stats: a provider that never reports cache reads never warns", () => {
	const stats = new CacheStats();
	for (let i = 0; i < 6; i++) assert.equal(stats.record(usage(10000, 0)), undefined);
});

test("cache stats: recovery re-arms the warning, and missing or junk usage is ignored", () => {
	const stats = new CacheStats();
	stats.record(usage(500, 9500));
	stats.record(usage(10000, 0));
	assert.ok(stats.record(usage(10000, 0)));
	stats.record(usage(500, 9500));
	stats.record(usage(10000, 0));
	assert.ok(stats.record(usage(10000, 0)), "warns again after a recovery");
	assert.equal(stats.record(undefined), undefined);
	assert.equal(stats.record({ input: "x", cacheRead: NaN }), undefined);
});

test("cache stats reach the user: turn_end feeds them, /goal-status verbose shows them, a collapse warns", async () => {
	const { stabilizationHarness } = await import("./support/stabilization-utils.ts");
	const h = stabilizationHarness();
	try {
		await h.start();
		const turn = (input: number, cacheRead: number) => h.event("turn_end", { message: { role: "assistant", content: [], usage: { input, cacheRead, cacheWrite: 0, output: 5 } } });
		await turn(500, 9500);
		await turn(10000, 0);
		assert.equal(h.notices.some(n => /cache hits fell/i.test(n)), false, "one bad request is not a warning");
		await turn(10000, 0);
		assert.equal(h.notices.filter(n => /cache hits fell to 0%/i.test(n)).length, 1);
		await h.commands.get("goal-status").handler("verbose", h.ctx);
		assert.ok(h.notices.some(n => /Prompt cache this session: \d+% of input read from cache over 3 requests/.test(n)), "verbose status shows the hit rate");
	} finally { await h.cleanup(); }
});
