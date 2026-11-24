import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import goalExtension from "../extensions/goal.ts";
import {createGoal, goalFocusDetails} from "../extensions/goal-record.ts";
import {writeActiveGoalFile} from "../extensions/storage/goal-files.ts";
import {readGoalLedger} from "../extensions/goal-ledger.ts";
import type {GoalCore} from "../extensions/goal-state.ts";

export function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return {promise, resolve, reject};
}

/** Registered extension boundary shared by the stabilization regressions. */
export function stabilizationHarness(auditor?: (...args: any[]) => Promise<any>) {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-stabilization-"));
	mkdirSync(path.join(cwd, ".pi/goals/archived"), {recursive: true});
	writeFileSync(path.join(cwd, ".pi/pi-goal-x-settings.json"), JSON.stringify({disabled: false, idleContinuationBackoff: false}));
	const goal = createGoal({objective: "Complete the tested stabilization", autoContinue: false, sisyphus: false});
	goal.id = "stabilization-goal";
	const written = writeActiveGoalFile({cwd}, goal);
	const handlers = new Map<string, any>(), tools = new Map<string, any>(), commands = new Map<string, any>();
	const notices: string[] = [], sent: unknown[] = [];
	let activeTools = ["read", "bash", "edit", "write"], toolInstalls = 0;
	let listener: ((data: string) => unknown) | undefined;
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t), registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => handlers.set(name, handler), appendEntry() {}, registerMessageRenderer() {},
		sendMessage: (m: unknown) => sent.push(m), sendUserMessage: (m: unknown) => sent.push(m),
		getActiveTools: () => activeTools, setActiveTools: (names: string[]) => { activeTools = names; toolInstalls++; },
		};
	const ctx: any = {
		cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, getSystemPrompt: () => "stable host policy", getContextUsage: () => ({tokens: 20, contextWindow: 1000}),
		sessionManager: {getSessionId: () => "same-session", getCwd: () => cwd, getRoot: () => cwd, getBranch: () => [{type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created")}]},
		ui: {notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {}, select: async () => undefined, input: async () => undefined, confirm: async () => false, custom: async () => "continue_working", onTerminalInput: (next: typeof listener) => {listener = next; return () => {listener = undefined;};}},
		modelRegistry: {getAvailable: () => []},
		};
	goalExtension(pi, auditor ? {runCompletionAuditor: auditor} : {});
	const core = pi._goalCore as GoalCore;
	const event = (name: string, data: any = {}, context = ctx) => handlers.get(name)?.(data, context);
	return {
		cwd, goal: written, ctx, core, tools, commands, notices, sent, event,
		start: () => event("session_start", {reason: "start"}),
		call: (name: string, params: unknown, context = ctx) => tools.get(name).execute("regression", params, new AbortController().signal, undefined, context),
		input: (data: string) => listener?.(data),
		get toolInstalls() {return toolInstalls;},
		disk: () => readFileSync(path.join(cwd, written.activePath!), "utf8"),
		ledger: () => readGoalLedger({cwd}).events,
		async cleanup() {
			try {await event("session_shutdown");} finally {core.stopAuditAnimation(); core.scheduler.shutdown(); core.clearContinuationState(); core.clearAuditResult(); rmSync(cwd, {recursive: true, force: true});}
		},
		};
}
