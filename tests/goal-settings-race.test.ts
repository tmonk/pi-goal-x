/**
 * Settings race test (plan §31): two real OS threads edit DIFFERENT keys of
 * the same global settings file concurrently. The locked mutation path must
 * serialize the writers so no key is lost.
 *
 * Run via: npm run test:settings-race
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { tempDir } from "./support/fs.ts";

const WORKER = new URL("./support/settings-race-worker.mjs", import.meta.url).pathname;

test("two concurrent processes editing different keys never lose an update", async () => {
	const dir = fs.realpathSync(tempDir("goal-settings-race-"));
	try {
		const globalFile = path.join(dir, "g.json");
		fs.writeFileSync(globalFile, "{}", "utf8");

		const runWriter = (key: string, iterations: number) =>
			new Promise<void>((resolve, reject) => {
				const worker = new Worker(WORKER, { workerData: { globalFile, key, iterations } });
				worker.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${key} exited ${code}`))));
			});

		const ITERATIONS = 25;
		await Promise.all([
			runWriter("provider", ITERATIONS),
			runWriter("model", ITERATIONS),
		]);

		const final = JSON.parse(fs.readFileSync(globalFile, "utf8"));
		assert.equal(final.provider, `provider-${ITERATIONS - 1}`, "writer A's final value present");
		assert.equal(final.model, `model-${ITERATIONS - 1}`, "writer B's final value present — no lost update");
		assert.ok(!fs.existsSync(`${globalFile}.lock`), "lock released");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
