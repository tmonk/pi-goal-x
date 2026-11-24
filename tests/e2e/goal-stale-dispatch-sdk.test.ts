import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

for (const handoff of [false, true]) test(`real SDK: rejected dispatches preserve replacement completion${handoff ? " after mid-run creation" : ""}`, {timeout: 15000}, async () => {
	const {NODE_TEST_CONTEXT: _dropped, ...env} = process.env;
	const {stdout} = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../support/stale-dispatch-sdk-worker.mjs", import.meta.url)), ...(handoff ? ["--handoff"] : [])], {env, timeout: 12000});
	const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
	assert.equal(result.passed, true);
	assert.equal(result.rejected, handoff ? 1 : 4);
	assert.equal(result.providerRequests, handoff ? 3 : 2);
});
