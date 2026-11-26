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
