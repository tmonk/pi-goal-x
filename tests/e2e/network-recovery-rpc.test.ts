/**
 * Real-runtime e2e: unbounded network-error recovery against a live pi process.
 *
 * Repro for the field report "unlimited retry + backoff is not working":
 * spawns an actual `pi --mode rpc` subprocess with this repo's goal extension,
 * points it at a local HTTP server that always returns
 *
 *     503 {"error":{"type":"server_error","message":"Error from provider
 *     (Console): Upstream request failed: Endpoint is unavailable."}}
 *
 * and asserts that, after Pi's built-in retries exhaust, the extension emits
 * escalating "Retrying the goal in Ns (recovery M, unbounded)" notifications
 * and delivers checkpoint continuations that restart the turn — i.e. the full
 * unbounded backoff loop runs against real provider-failure event shapes.
 *
 * Skipped when the `pi` CLI is not on PATH. Runtime ~30s (bounded).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { createGoal } from "../../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";
import { tempDir } from "../support/fs.ts";

const EXT_PATH = path.resolve(import.meta.dirname!, "..", "..", "extensions", "goal.ts");

function piOnPath(): boolean {
	try {
		const probe = spawnSync("pi", ["--version"], { timeout: 15_000 });
		return probe.status === 0;
	} catch {
		return false;
	}
}

interface Notify {
	message: string;
	notifyType?: string;
}

interface OutageScenario {
	status: number;
	body: unknown;
	label: string;
}

const SCENARIO_503: OutageScenario = {
	status: 503,
	label: "503",
	body: {
		error: {
			type: "server_error",
			message:
				"Error from provider (Console): Upstream request failed: Endpoint is unavailable.",
		},
	},
};

/** The exact second field-reported failure shape (OpenRouter-style 429). */
const SCENARIO_429: OutageScenario = {
	status: 429,
	label: "429",
	body: {
		message: "Provider returned error",
		code: 429,
		metadata: {
			raw: "stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.",
			provider_name: "Stealth",
			is_byok: false,
			limit_source: "upstream_provider_shared_pool",
		},
	},
};

async function runOutageScenario(t: import("node:test").TestContext, scenario: OutageScenario): Promise<Notify[]> {
	// ── Mock provider: always fails with the scenario payload ──────────────
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		req.resume();
		res.writeHead(scenario.status, { "content-type": "application/json" });
		res.end(JSON.stringify(scenario.body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	t.after(() => server.close());

	// ── Isolated agent dir + project cwd ───────────────────────────────────
	const work = tempDir("goal-netrecovery-e2e-");
	t.after(() => {
		try {
			rmSync(work, { recursive: true, force: true });
		} catch {}
	});
	const agentDir = path.join(work, "agent");
	const projectDir = path.join(work, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(path.join(projectDir, ".pi", "goals"), { recursive: true });

	// pi settings: tiny provider-retry delays so each failing turn is fast.
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "mock503",
			defaultModel: "broken",
			retry: { maxRetries: 3, baseDelayMs: 10 },
		}),
	);
	// Custom provider pointing at the always-503 mock.
	writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			mock503: {
				baseUrl: `http://127.0.0.1:${port}/v1`,
				api: "openai-completions",
				apiKey: "dummy",
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				models: [{ id: "broken", name: "Broken 503" }],
			},
		},
	}));
	// pi-goal-x settings: auto-focus the single active goal in fresh sessions.
	writeFileSync(path.join(agentDir, "pi-goal-x-settings.json"), JSON.stringify({ autoSelectSingleGoal: true, maxAutonomousRuns: 100 }));

	// Seed one active auto-continue goal via the extension's own serializers.
	const goal = createGoal(
		{ objective: "keep making progress despite provider outages", autoContinue: true, sisyphus: false },
		Date.UTC(2026, 7, 25, 12, 0, 0),
	);
	writeActiveGoalFile({ cwd: projectDir }, goal);

	// ── Drive a real pi RPC session ────────────────────────────────────────
	const child = spawn(
		"pi",
		["--mode", "rpc", "-e", EXT_PATH, "-ne", "--no-session"],
		{
			cwd: projectDir,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	t.after(() => {
		child.kill("SIGKILL");
	});
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});

	const notifications: Notify[] = [];
	const rawLines: string[] = [];
	let sawCheckpointAfterSettle = false;
	let sawFirstNotify = false;

	const linesReady: Array<{ resolve: () => void }> = [];
	let lineBuffer = "";
	let streamClosed = false;
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		lineBuffer += chunk;
		let index: number;
		while ((index = lineBuffer.indexOf("\n")) !== -1) {
			const line = lineBuffer.slice(0, index);
			lineBuffer = lineBuffer.slice(index + 1);
			ingest(line);
		}
		for (const waiter of linesReady.splice(0)) waiter.resolve();
	});
	child.stdout?.on("close", () => {
		streamClosed = true;
		for (const waiter of linesReady.splice(0)) waiter.resolve();
	});

	function ingest(line: string): void {
		if (!line.trim()) return;
		if (rawLines.length < 80) rawLines.push(line);
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "extension_ui_request") {
			const method = event.method as string | undefined;
			if (method === "notify") {
				const params = (event.params ?? {}) as { message?: string; notifyType?: string };
				const message = (params.message ?? (event as { message?: string }).message) as string | undefined;
				if (message && /Retrying the goal in \d+s \(recovery \d+, unbounded\)/.test(message)) {
					notifications.push({ message, notifyType: params.notifyType ?? (event as { notifyType?: string }).notifyType });
					sawFirstNotify = true;
				}
			}
		}
		if (
			sawFirstNotify &&
			event.type === "message_end" &&
			(event.message as { role?: string } | undefined)?.role === "custom"
		) {
			sawCheckpointAfterSettle = true;
		}
	}

	function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const started = Date.now();
			const poll = () => {
				if (predicate()) return resolve(true);
				if (Date.now() - started > timeoutMs || streamClosed) return resolve(false);
				setTimeout(poll, 250);
			};
			poll();
		});
	}

	child.stdin!.write(JSON.stringify({ id: "r1", type: "prompt", message: "continue working on the task" }) + "\n");

	// The first notification proves recovery engaged after Pi's own retries;
	// the second proves the delivered continuation restarted the loop.
	const gotTwo = await waitFor(() => notifications.length >= 2, 45_000);
	child.kill("SIGKILL");

	assert.ok(
		gotTwo,
		`[${scenario.label}] expected at least 2 recovery notifications within 45s; got ${JSON.stringify(notifications)};\nfirst raw lines:\n${rawLines.join("\n").slice(0, 4000)}\nstderr:\n${stderr.slice(0, 2000)}`,
	);
	assert.ok(sawCheckpointAfterSettle, `[${scenario.label}] a checkpoint continuation must be delivered after the first recovery`);

	return notifications;
}

function assertEscalatingUnbounded(notifications: Notify[], label: string): void {
	const delays = notifications.map((n) => Number(/in (\d+)s/.exec(n.message)?.[1]));
	const attempts = notifications.map((n) => Number(/recovery (\d+)/.exec(n.message)?.[1]));
	assert.ok(delays.length >= 2 && delays[1]! > delays[0]!, `[${label}] delays must escalate: ${delays.join(", ")}`);
	assert.equal(attempts[0]!, 1, `[${label}] the counter starts at recovery 1 in a fresh session`);
	assert.deepEqual(
		notifications.slice(0, 2).map((n) => n.notifyType),
		["warning", "warning"],
		`[${label}]`,
	);
}

test("e2e: real pi recovers from sustained 503 outages with escalating unbounded backoff", async (t) => {
	if (!piOnPath()) {
		t.skip("pi CLI not available on PATH");
		return;
	}
	const notifications = await runOutageScenario(t, SCENARIO_503);
	assertEscalatingUnbounded(notifications, "503");
});

test("e2e: real pi recovers from sustained 429 rate-limit outages", async (t) => {
	if (!piOnPath()) {
		t.skip("pi CLI not available on PATH");
		return;
	}
	const notifications = await runOutageScenario(t, SCENARIO_429);
	assertEscalatingUnbounded(notifications, "429");
});
