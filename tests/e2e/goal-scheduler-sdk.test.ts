import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("real SDK: opt-in uncapped runs retain waits, one repair and stale-wake protection", { timeout: 30000 }, async () => {
	const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../scheduler-sdk-worker.mjs", import.meta.url)), "--uncapped"], { timeout: 25000 });
	const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
	assert.equal(result.passed, true);
	assert.equal(result.requests, 8);
	assert.equal(result.used, 4);
});

test("real SDK: explicit dispositions, custom wakes and one repair enforce allowance", { timeout: 30000 }, async () => {
	const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../scheduler-sdk-worker.mjs", import.meta.url))], { timeout: 25000 });
	assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)!).passed, true);
});


test("real SDK: native retry and compaction preserve consumed autonomous allowance", { timeout: 30000 }, async () => {
	const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../scheduler-sdk-worker.mjs", import.meta.url)), "--lifecycle"], { timeout: 25000 });
	const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
	assert.equal(result.passed, true);
	assert.equal(result.requests, 10);
	assert.equal(result.used, 4);
	assert.equal(result.compactionRequests, 1);
	assert.ok(result.retries > 0);
});

test("real SDK: opted-in idle runs are paced and producer/resume work starts promptly", { timeout: 30000 }, async () => {
	const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../scheduler-sdk-worker.mjs", import.meta.url)), "--implicit"], { timeout: 25000 });
	const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
	assert.equal(result.passed, true);
	assert.equal(result.requests, 6);
	assert.equal(result.used, 2);
});
