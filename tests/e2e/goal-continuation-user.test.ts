import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Each case runs its own worker and temp directory, so run them at once.
describe("standard user", { concurrency: true }, () => {
	for (const mode of ["draft", "direct", "pause", "reload", "abort", "turn-first"]) test(`standard user: ${mode} starts with the correct profile and reaches audited completion`, { timeout: 30000 }, async () => {
		const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../continuation-user-sdk-worker.mjs", import.meta.url)), mode], { timeout: 25000 });
		const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
		assert.equal(result.passed, true);
		assert.equal(result.initialExecutionPromptCorrect, true);
		assert.equal(result.executorPrefixStable, true);
		assert.equal(result.nativePromptPreparation, true);
		assert.equal(result.externalPromptInstructionPreserved, true);
		assert.equal(result.artifact, "verified result\n");
		if (mode === "pause" || mode === "reload") assert.equal(result.paused, true);
		if (mode === "reload") assert.equal(result.reloadedWhilePaused, true);
		if (mode === "abort") assert.equal(result.pausedBeforeAnyRequest, true);
		if (mode === "turn-first") assert.equal(result.heldBeforeResume, true);
	});
});
