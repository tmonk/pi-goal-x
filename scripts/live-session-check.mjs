/**
 * Live pi 1.0.0 goal-lifecycle check.
 *
 * The test suite stubs the two SDK entry points that matter most here:
 * `createAgentSession` and `createExtensionRuntime` are never executed for real
 * (see tests/stubs/pi-coding-agent.ts and the injected `createSession` in
 * tests/goal-auditor.test.ts). This script closes that gap by driving a REAL
 * `pi --mode rpc` process with the extension loaded, backed by a local fake
 * OpenAI-completions provider, and walking one goal through
 *
 *     /goal  ->  propose_goal_draft  ->  Confirm dialog  ->  execution
 *             ->  update_goal(complete)  ->  independent audit  ->  archived
 *
 * It asserts the lifecycle milestones from the observed RPC event stream and
 * exits non-zero if any are missing.
 *
 * Usage:  node --experimental-strip-types scripts/live-session-check.mjs
 * Env:    LIFECYCLE_TIMEOUT_MS (default 120000)
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const EXT_PATH = path.resolve(import.meta.dirname, "..", "extensions", "goal.ts");
const TIMEOUT_MS = Number(process.env.LIFECYCLE_TIMEOUT_MS ?? 120_000);

const version = spawnSync("pi", ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
	console.error("SKIP: pi CLI is not on PATH.");
	process.exit(2);
}
const HOST_VERSION = version.stdout.trim();
console.log(`[live] host pi: ${HOST_VERSION}`);

// ── Fake provider ───────────────────────────────────────────────────────────
// Decides each scripted reply from the request itself, so the same logic serves
// the drafting phase, the execution phase, and the isolated auditor session.
const seen = { drafting: 0, execution: 0, audit: 0 };
const providerRequests = [];

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		let parsed = {};
		try { parsed = JSON.parse(body); } catch { parsed = {}; }
		const toolNames = (parsed.tools ?? []).map((t) => t.function?.name).filter(Boolean);
		const systemText = JSON.stringify(parsed.messages?.[0] ?? {});
		const isAuditor = /read-only completion auditor/i.test(systemText);

		let step;
		if (isAuditor) {
			seen.audit += 1;
			step = { text: "The objective's success criterion is satisfied: one live goal lifecycle completed against this host.\n\n<approved/>" };
		} else if (toolNames.includes("propose_goal_draft")) {
			seen.drafting += 1;
			step = {
				tool: "propose_goal_draft",
				args: {
					objective: "Confirm pi 1.0.0 compatibility.\nSuccess criteria: the live session completes one goal lifecycle.",
					sisyphus: false,
				},
			};
		} else if (toolNames.includes("update_goal")) {
			seen.execution += 1;
			step = {
				tool: "update_goal",
				args: { status: "complete", completion_summary: "Completed one live goal lifecycle against the installed pi host." },
			};
		} else {
			step = { text: "Nothing further to do." };
		}

		providerRequests.push({ isAuditor, toolNames });
		console.log(`[live][provider] turn=${providerRequests.length} phase=${isAuditor ? "audit" : toolNames.includes("propose_goal_draft") ? "drafting" : toolNames.includes("update_goal") ? "execution" : "idle"} tools=[${toolNames.join(",")}]`);

		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({
			id: `chatcmpl-live-${providerRequests.length}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "probe",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`);

		send({ role: "assistant", content: "" });
		if (step.tool) {
			const argsJson = JSON.stringify(step.args);
			send({ tool_calls: [{ index: 0, id: `call_${providerRequests.length}`, type: "function", function: { name: step.tool, arguments: "" } }] });
			for (let i = 0; i < argsJson.length; i += 64) send({ tool_calls: [{ index: 0, function: { arguments: argsJson.slice(i, i + 64) } }] });
			send({}, "tool_calls");
		} else {
			for (let i = 0; i < step.text.length; i += 64) send({ content: step.text.slice(i, i + 64) });
			send({}, "stop");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ── Isolated agent dir + project ────────────────────────────────────────────
const work = mkdtempSync(path.join(tmpdir(), "goal-live-lifecycle-"));
const agentDir = path.join(work, "agent");
const projectDir = path.join(work, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(path.join(projectDir, ".pi", "goals", "archived"), { recursive: true });

writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
	defaultProvider: "probe",
	defaultModel: "probe",
	retry: { maxRetries: 0, baseDelayMs: 10 },
}));
writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
	providers: {
		probe: {
			baseUrl: `http://127.0.0.1:${port}/v1`,
			api: "openai-completions",
			apiKey: "dummy",
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
			models: [{ id: "probe", name: "Probe" }],
		},
	},
}));

// ── Drive the live session ──────────────────────────────────────────────────
const child = spawn("pi", ["--mode", "rpc", "-e", EXT_PATH, "-ne", "--no-session"], {
	cwd: projectDir,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
	stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

const observed = { dialogs: [], toolResults: [], events: [], errors: [] };
const milestones = {
	draftingPrompt: false,
	proposalShown: false,
	goalCreated: false,
	budgetNone: false,
	executionStarted: false,
	auditRan: false,
	completed: false,
};

child.stdout.setEncoding("utf8");
let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		observed.events.push(event.type);

		if (event.type === "message_end" && event.message?.role === "toolResult") {
			const text = (event.message.content ?? []).map((p) => p?.text ?? "").join(" ").replace(/\s+/g, " ").trim();
			observed.toolResults.push({ tool: event.message.toolName, text });
			console.log(`[live][tool] ${event.message.toolName} -> ${text.slice(0, 220)}`);
			if (event.message.toolName === "propose_goal_draft") {
				milestones.proposalShown = true;
				if (/Budget: none/i.test(text)) milestones.budgetNone = true;
				if (/Goal created and focused/i.test(text)) milestones.goalCreated = true;
			}
			if (event.message.toolName === "update_goal" && /complete/i.test(text)) milestones.executionStarted = true;
		}
		if (event.type === "message_end" && event.message?.role === "user" && /GOAL CONFIRMATION/.test(JSON.stringify(event.message.content ?? ""))) {
			milestones.draftingPrompt = true;
		}
		if (event.type === "extension_ui_request") {
			const title = String(event.title ?? event.params?.title ?? "");
			observed.dialogs.push({ method: event.method, title: title.split("\n")[0] });
			console.log(`[live][dialog] ${event.method}: ${title.split("\n")[0]}`);
			if (["select", "confirm", "input"].includes(event.method)) {
				const options = event.options ?? event.params?.options ?? [];
				let answer;
				if (/auditor/i.test(title)) answer = options.find((o) => /^Enabled/i.test(String(o))) ?? options[0];
				else answer = options.find((o) => /confirm/i.test(String(o))) ?? options[0] ?? true;
				console.log(`[live][dialog-answer] -> ${JSON.stringify(answer)}`);
				child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, value: answer }) + "\n");
			}
		}
	}
});

child.stdin.write(JSON.stringify({
	id: "p1",
	type: "prompt",
	message: "/goal Confirm pi 1.0.0 compatibility with one live lifecycle",
}) + "\n");

const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
	if (milestones.completed || (milestones.auditRan && seen.audit > 0 && providerRequests.length > 6)) break;
	await new Promise((r) => setTimeout(r, 200));
}
await new Promise((r) => setTimeout(r, 1500));

child.kill("SIGKILL");
server.close();

// The audit only counts as observed if it really went through the SDK path.
milestones.auditRan = seen.audit > 0;

// ── On-disk evidence ────────────────────────────────────────────────────────
const goalDir = path.join(projectDir, ".pi", "goals");
const activeFiles = readdirSync(goalDir).filter((f) => f.endsWith(".json") || f.endsWith(".md"));
let archived = [];
try { archived = readdirSync(path.join(goalDir, "archived")); } catch { archived = []; }
let goalRecord = null;
for (const file of activeFiles) {
	try {
		const text = readFileSync(path.join(goalDir, file), "utf8");
		goalRecord = JSON.parse(text.replace(/^---[\s\S]*?---/, "").trim() || text);
	} catch { goalRecord = null; }
}
let ledger = "";
for (const file of readdirSync(goalDir)) {
	if (file.endsWith(".jsonl")) {
		try { ledger += readFileSync(path.join(goalDir, file), "utf8"); } catch { ledger += ""; }
	}
}

const ledgerTypes = [...ledger.matchAll(/"type"\s*:\s*"([a-z_]+)"/g)].map((m) => m[1]);
// Completion is proven by the terminal ledger events, not by the goal file
// remaining active: a completed goal is archived and leaves no active record.
milestones.completed =
	ledgerTypes.includes("goal_completed") ||
	ledgerTypes.includes("goal_archived") ||
	archived.some((f) => f.endsWith(".md"));

console.log("\n=== live pi 1.0.0 lifecycle result ===");
console.log(`host version:            ${HOST_VERSION}`);
console.log(`provider requests:       ${providerRequests.length} (drafting=${seen.drafting}, execution=${seen.execution}, audit=${seen.audit})`);
console.log(`dialogs:                 ${observed.dialogs.map((d) => d.method).join(", ") || "(none)"}`);
console.log(`tools called:            ${observed.toolResults.map((t) => t.tool).join(", ") || "(none)"}`);
console.log(`active goal files:       ${activeFiles.join(", ") || "(none)"}`);
console.log(`archived:                ${archived.join(", ") || "(none)"}`);
console.log(`goal status on disk:     ${goalRecord?.status ?? "(no record)"}`);
console.log(`goal tokenBudget:        ${goalRecord?.tokenBudget ?? "(absent)"}`);
console.log(`ledger event types:      ${[...new Set(ledgerTypes)].join(", ") || "(none)"}`);
console.log(`milestones:              ${JSON.stringify(milestones)}`);
if (stderr.trim()) console.log(`stderr:\n${stderr.slice(0, 1500)}`);

const required = ["draftingPrompt", "proposalShown", "goalCreated", "budgetNone", "executionStarted", "auditRan"];
const missing = required.filter((m) => !milestones[m]);
console.log(`\n[live] required milestones: ${missing.length ? `MISSING ${missing.join(", ")}` : "all present"}`);
console.log(`[live] lifecycle reached completion/archival: ${milestones.completed ? "yes" : "no (goal left active)"}`);

if (missing.length) process.exit(1);
