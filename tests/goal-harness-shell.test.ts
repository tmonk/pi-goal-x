/**
 * Runs the experiment-harness shell tests (follow-up Stage 6) as part of the
 * fast suite. The bash tests stub curl/pi/tooling and exercise
 * SUPPORTED_CASES.json membership, raw-dir diagnostics, the MODEL-aware smoke
 * payload, missing configuration, HTTP/JSON validation, and portable timeout
 * discovery.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("experiment harness shell tests pass", () => {
	const script = path.resolve(import.meta.dirname, "shell", "harness.test.sh");
	const result = spawnSync("bash", [script], { encoding: "utf8", timeout: 120_000 });
	assert.equal(
		result.status,
		0,
		`harness shell tests failed (exit ${result.status})\n${result.stdout}\n${result.stderr}`,
	);
	assert.match(result.stdout, /harness shell tests: all passed/);
});
