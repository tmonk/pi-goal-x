import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("real SDK: explicit and implicit caching preserve request prefixes", {timeout: 30000}, async () => {
	// A nested node --test run inherits the parent runner's NODE_TEST_CONTEXT and then
	// suppresses its own TAP stdout. Scrub it so the worker's output stays observable.
	const { NODE_TEST_CONTEXT: _dropped, ...childEnv } = process.env;
	const {stdout} = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--test", fileURLToPath(new URL("../support/prompt-cache-sdk-worker.ts", import.meta.url))], {timeout: 25000, env: childEnv});
	assert.match(stdout, /(?:#|ℹ) pass 9/);
	assert.match(stdout, /(?:#|ℹ) fail 0/);
});
