import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("real SDK: goal context edits keep mid-session prompt deltas out of the leading prompt", { timeout: 30_000 }, async () => {
	const { NODE_TEST_CONTEXT: _dropped, ...env } = process.env;
	const worker = fileURLToPath(new URL("../context-system-sdk-worker.mjs", import.meta.url));
	const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", worker], { timeout: 25_000, env });
	assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)!).passed, true);
});
