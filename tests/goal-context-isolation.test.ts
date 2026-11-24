import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";

test("real SDK captures isolate concurrent workspaces and failure cleanup", () => {
	const env = {...process.env};
	delete env.NODE_TEST_CONTEXT;
	const output = execFileSync(process.execPath, ["--experimental-strip-types", "tests/support/context-isolation-sdk-worker.mjs"], {env, encoding: "utf8", timeout: 30000});
	assert.deepEqual(JSON.parse(output.trim().split("\n").at(-1)!), {passed: true, cases: 2});
});
