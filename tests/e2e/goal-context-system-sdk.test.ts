import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Each case runs its own worker and temp directory, so run them at once.
describe("real SDK: system deltas", { concurrency: true }, () => {
	for (const args of [[], ["--automatic"], ["--child"]]) test(`real SDK: system deltas preserve the first prefix and survive compaction ${args.join(" ")}`, {timeout: 20000}, async () => {
		const {NODE_TEST_CONTEXT: _dropped, ...env} = process.env;
		const {stdout} = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../context-system-sdk-worker.mjs", import.meta.url)), ...args], {env, timeout: 15000});
		const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
		assert.equal(result.passed, true);
		assert.equal(result.fullTranscript, true);
		assert.ok(result.requests >= 8, "turns, a model change, compaction and resumed turns ran");
	});
});
