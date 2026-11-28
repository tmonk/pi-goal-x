import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("real SDK: a goal's whole life keeps every request a prefix of the next", { timeout: 60000 }, async () => {
	const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../support/prefix-lifecycle-sdk-worker.mjs", import.meta.url))], { timeout: 55000 });
	const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
	assert.equal(result.passed, true);
	assert.equal(result.breaks, 0);
	assert.ok(result.requests >= 10);
});
