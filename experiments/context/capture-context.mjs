/**
 * Composed-request capture (PR D). Drives the REAL extension handlers over a
 * fixture and returns the complete model-facing request parts:
 *
 *   baseSystem       — the host system prompt before extension injection
 *   extensionSystem  — what before_agent_start appends
 *   messages         — the provider message list AFTER the context hook
 *   tools            — registered goal tools (name + description + schema)
 *
 * Pure in-process function calls over fixture data: no network, no child
 * agent, no live model.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createCodingToolDefinitions as createCodingTools, createReadOnlyToolDefinitions as createReadOnlyTools } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js";
import { buildSystemPrompt } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { runGoalCompletionAuditor } from "../../extensions/goal-auditor.ts";
import { runBlockerOracle } from "../../extensions/goal-oracle.ts";
import piGoalExtension from "../../extensions/goal.ts";
import { FIXTURES, userMessage, v2CheckpointMessage, assistantMessage } from "./fixtures.mjs";
import { serializeGoalFile } from "../../extensions/storage/goal-files.ts";
import { GOAL_LEDGER_FILE } from "../../extensions/goal-ledger.ts";

const HOST_TOOLS = createCodingTools("/fixture");
export function sdkSystem(definitions, customPrompt) {
 const raw = buildSystemPrompt({ customPrompt, cwd: "/fixture", skills: [], contextFiles: [], selectedTools: definitions.map(t => t.name), toolSnippets: Object.fromEntries(definitions.map(t => [t.name, t.promptSnippet ?? ""])), promptGuidelines: definitions.flatMap(t => t.promptGuidelines ?? []) });
 // SDK installation location is not extension overhead and differs in CI.
 return raw.replaceAll(fs.realpathSync(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url)), "/sdk");
}
const BASE_SYSTEM = sdkSystem(HOST_TOOLS);

function createCapture(cwd) {
 const hostTools = createCodingTools(cwd);
	const handlers = new Map();
	const tools = [];
 let activeTools = hostTools.map(t => t.name);

	const mockPi = {
		// Pi activates every registered tool by default, in registration order.
		registerTool: (def) => { tools.push(def); activeTools.push(def.name); },
		registerCommand: () => {},
		on: (event, handler) => {
			const previous = handlers.get(event);
			handlers.set(event, async (eventArg, ctxArg) => {
				const prior = await previous?.(eventArg, ctxArg);
				const next = await handler(prior ? { ...eventArg, ...prior } : eventArg, ctxArg);
				return next ? { ...prior, ...next } : prior;
			});
		},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
	};

	const ctx = {
		cwd: cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => [],
			getCwd: () => cwd,
			getSessionId: () => "capture",
			getRoot: () => cwd,
			append: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "capture", model: null, thinkingLevel: "medium" }),
			getSessionFile: () => undefined,
		},
		getSystemPrompt: () => sdkSystem(activeTools.map(name => [...hostTools, ...tools].find(t => t.name === name)).filter(Boolean)),
		isIdle: () => true,
		hasPendingMessages: () => false,
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify: () => {}, setStatus: () => {}, setWidget: () => {},
			select: async () => undefined, input: async () => undefined, confirm: async () => false,
		},
	};

	piGoalExtension(mockPi);

	async function startSession(entries) {
		ctx.sessionManager.getBranch = () => entries;
		await handlers.get("session_start")({ reason: "start" }, ctx);
	}

	async function runTurn(triggerPrompt) {
		return (await handlers.get("before_agent_start")(
			{ systemPrompt: BASE_SYSTEM, prompt: triggerPrompt, messageType: "user", systemPromptOptions: {} },
			ctx,
		)) ?? {};
	}

	async function runContext(messages) {
		const head = { role: "system", content: ctx.getSystemPrompt() };
		const event = { messages: [head, ...messages] };
		const result = await handlers.get("context_with_system")(event, ctx);
		const full = result?.messages ?? event.messages;
		if (full[0] !== head) throw new Error("Goal filtering changed the host system prompt");
		return full.slice(1);
	}

	return { tools, startSession, runTurn, runContext, ctx,
  get activeTools() { return activeTools.map(name => tools.find(t => t.name === name)).filter(Boolean); },
  compact: () => handlers.get("session_compact")({}, ctx),
 };
}

/** Materialize goal files, focus entry, and ledger events for a scenario. */
function materializeState(scenario, cwd) {
	fs.mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });

	if (scenario.settings) fs.writeFileSync(path.join(cwd, ".pi/pi-goal-x-settings.json"), JSON.stringify(scenario.settings));
 const entries = [];
 if (scenario.draftPrompt) entries.push({ type: "custom", customType: "pi-goal-draft", data: { version: 1, mode: "goal", seed: "build the thing", startedAt: "2026-08-23T12:00:00.000Z", auditorEnabled: true } });
	const goals = scenario.goal ? [scenario.goal] : [];
	if (scenario.extraOpenGoals) goals.push(...scenario.extraOpenGoals);

	for (const goal of goals) {
		const relPath = `.pi/goals/active_goal_${goal.id}.md`;
		goal.activePath = relPath;
		fs.writeFileSync(path.join(cwd, relPath), serializeGoalFile(goal), "utf8");
		entries.push({ type: "custom", customType: "pi-goal-state", data: { version: 3, goal } });
	}

	if (goals.length > 0) {
		const focusedGoalId = scenario.focusNull ? null : scenario.goal.id;
		entries.unshift({
			type: "custom",
			customType: "pi-goal-focus",
			data: { version: 1, focusedGoalId, reason: "created" },
		});
	}

	if (scenario.ledgerEvents?.length > 0) {
		const lines = scenario.ledgerEvents.map((e) => JSON.stringify(e)).join("\n");
		fs.writeFileSync(path.join(cwd, GOAL_LEDGER_FILE), `${lines}\n`, "utf8");
	}
	return entries;
}

/** Deterministic default conversation for active-goal fixtures. */
function baseConversation(goal) {
	const messages = [userMessage("Begin working on the goal.")];
	for (let i = 1; i <= 3; i += 1) {
		messages.push(v2CheckpointMessage(goal.id, i));
		messages.push(assistantMessage(`Turn ${i} progress notes.`));
	}
	return messages;
}

/** Capture one fixture's composed request. */
export async function captureOne(fixtureId, { inspect, settings } = {}) {
	const build = FIXTURES[fixtureId];
	if (!build) throw new Error(`unknown fixture: ${fixtureId}`);
	const scenario = build();
	if (settings) scenario.settings = {...scenario.settings, ...settings};

	const cwd = fs.mkdtempSync(path.join(tmpdir(), "goal-context-capture-"));
 try {
	const capture = createCapture(cwd);
	const entries = materializeState(scenario, cwd);
 const allHostTools = [...createCodingTools(cwd), ...createReadOnlyTools(cwd)];
	await capture.startSession(entries);
	if (fixtureId === "post-compaction-turn") await capture.compact();
 const turn = await capture.runTurn(scenario.trigger ?? "continue");

	let raw = scenario.messages ?? (scenario.goal ? baseConversation(scenario.goal) : [userMessage("Hello")]);
	if (scenario.draftPrompt) raw = [...raw, userMessage(scenario.draftPrompt)];
	const messages = [...raw];

	const actualSystem = turn.systemPrompt ?? capture.ctx.getSystemPrompt();
 const childRequests = [];
 if (fixtureId === "completion-audit" || fixtureId === "audit-rejection-and-rework" || fixtureId === "oracle-consultation") {
  const createSession = async options => ({ session: {
   subscribe: () => () => {}, abort: () => {},
   prompt: async text => {
    const defs = options.tools.map(t => typeof t === "string" ? [...allHostTools, ...(options.customTools ?? [])].find(d => d.name === t) : t).filter(Boolean);
    childRequests.push({ kind: fixtureId === "oracle-consultation" ? "oracle" : "auditor", system: sdkSystem(defs, options.resourceLoader?.getSystemPrompt()), messages: [userMessage(text)], tools: defs.map(toolCapture) });
   },
  } });
  const ctx = { ...capture.ctx, modelRegistry: { getAvailable: () => [], find: () => ({ id: "fixture", provider: "fixture" }) } };
  if (fixtureId === "oracle-consultation") await runBlockerOracle({ ctx, goal: scenario.goal, reason: "Missing dependency", attemptedActions: ["Inspect configuration"], recentEvidence: "Dependency is absent", settings: { enabled: true, provider: "fixture", model: "fixture", maxFailedAttemptsPerBlocker: 2 }, createSession });
  else await runGoalCompletionAuditor({ ctx, goal: scenario.goal, detailedSummary: "fixture", completionSummary: "Implemented and tested", warmContext: "Recent test evidence", createSession });
 }
 if (fixtureId === "get-goal-default-and-verbose") {
  for (const params of [{}, {verbose: true}]) {
   const result = await capture.tools.find(t => t.name === "get_goal").execute("capture", params, new AbortController().signal, undefined, capture.ctx);
   messages.push({ role: "toolResult", toolName: "get_goal", toolCallId: "capture", content: result.content });
  }
 }
 const providerMessages = await capture.runContext(messages);
 const result = {
  childRequests,
  sdkGuidanceChars: capture.ctx.getSystemPrompt().length - BASE_SYSTEM.length,
  hostTools: HOST_TOOLS.map(toolCapture),
		fixture: fixtureId,
		baseSystem: capture.ctx.getSystemPrompt(),
		extensionSystem: actualSystem.slice(capture.ctx.getSystemPrompt().length),
		messages: providerMessages,
		tools: capture.activeTools.map(toolCapture),
	};
 await inspect?.(result, {cwd, scenario, capture, baseMessages: messages});
 return result;
 } finally {
  fs.rmSync(cwd, {recursive: true, force: true});
 }
}

function toolCapture(t) { return { name: t.name, description: t.description ?? "", schema: t.parameters ?? t.schema ?? null }; }
export { BASE_SYSTEM };
