/**
 * Shared fake Pi host for tests that load the whole extension.
 *
 * It records every registration and host call the extension makes, so a test
 * can drive lifecycle events, call tools and commands, and inspect what the
 * extension asked the host to do. Tests override only what they exercise.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../../extensions/goal.ts";
import type { GoalCore } from "../../extensions/goal-state.ts";
import type { runGoalCompletionAuditor } from "../../extensions/goal-auditor.ts";

export const DEFAULT_ACTIVE_TOOLS = ["read", "bash", "edit", "write"];

export interface ExtensionHarnessOptions {
	cwd: string;
	/**
	 * Session branch. An array or function is returned as given. "recorded"
	 * (the default when omitted) returns the entries the extension appended.
	 */
	sessionEntries?: unknown[] | (() => unknown[]) | "recorded";
	hasUI?: boolean;
	mode?: string;
	sessionId?: string;
	systemPrompt?: string;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	runCompletionAuditor?: typeof runGoalCompletionAuditor | ((...args: any[]) => Promise<any>);
	/** Replaces individual ctx.ui methods. */
	ui?: Record<string, unknown>;
	/** Extra or replacement ctx fields. */
	ctx?: Record<string, unknown>;
	/** Extra or replacement pi fields. */
	pi?: Record<string, unknown>;
	/** "dialog" makes ctx.ui.custom wait for resolveDialog(). */
	custom?: "dialog";
}

export interface Notice { message: string; level?: string }

export function createExtensionHarness(options: ExtensionHarnessOptions) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	const notices: Notice[] = [];
	const userMessages: unknown[] = [];
	const userMessageModes: Array<string | undefined> = [];
	const sentMessages: any[] = [];
	const toolHistory: string[][] = [];
	let activeTools = [...DEFAULT_ACTIVE_TOOLS];
	let abortCount = 0;
	let resolvePendingDialog: ((result: unknown) => void) | null = null;
	let terminalInputHandler: ((data: string) => unknown) | null = null;

	const branch = options.sessionEntries ?? "recorded";
	const getBranch = branch === "recorded" ? () => [...entries] : typeof branch === "function" ? branch : () => branch;
	const hasUI = options.hasUI ?? false;

	const pi = {
		registerTool: (definition: any) => { tools.set(definition.name, definition); },
		registerCommand: (name: string, definition: any) => { commands.set(name, definition); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		registerMessageRenderer: () => {},
		sendMessage: (message: unknown) => { sentMessages.push(message); },
		sendUserMessage: (message: unknown, options?: { deliverAs?: string }) => { userMessages.push(message); userMessageModes.push(options?.deliverAs); },
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; toolHistory.push([...names]); },
		hasUI,
		...options.pi,
	};

	const ctx = {
		cwd: options.cwd,
		hasUI,
		...(options.mode === undefined ? {} : { mode: options.mode }),
		sessionManager: {
			getBranch,
			getCwd: () => options.cwd,
			getSessionId: () => options.sessionId ?? "test-session",
			getRoot: () => options.cwd,
		},
		ui: {
			notify: (message: string, level?: string) => { notices.push({ message, level }); },
			setStatus: () => {},
			setWidget: () => {},
			setWorkingVisible: () => {},
			onTerminalInput: (handler: (data: string) => unknown) => {
				terminalInputHandler = handler;
				return () => { terminalInputHandler = null; };
			},
			select: async () => undefined,
			input: async () => undefined,
			confirm: async () => false,
			custom: options.custom === "dialog"
				? () => new Promise((resolve) => { resolvePendingDialog = resolve; })
				: async () => undefined,
			...options.ui,
		},
		getSystemPrompt: () => options.systemPrompt ?? "base",
		isIdle: options.isIdle ?? (() => true),
		hasPendingMessages: options.hasPendingMessages ?? (() => false),
		abort: () => { abortCount += 1; },
		...options.ctx,
	} as unknown as ExtensionContext;

	goalExtension(pi as any, options.runCompletionAuditor ? { runCompletionAuditor: options.runCompletionAuditor as typeof runGoalCompletionAuditor } : {});
	const core = (pi as unknown as { _goalCore: GoalCore })._goalCore;
	const emit = async (event: string, data: unknown = {}, context: ExtensionContext = ctx) => handlers.get(event)?.(data, context);

	return {
		pi,
		ctx,
		core,
		handlers,
		commands,
		tools,
		entries,
		notices,
		userMessages,
		/** deliverAs for each entry in userMessages. */
		userMessageModes,
		sentMessages,
		toolHistory,
		get notifications() { return notices.map((notice) => notice.message); },
		get activeTools() { return [...activeTools]; },
		get abortCount() { return abortCount; },
		hasDialog: () => resolvePendingDialog !== null,
		resolveDialog(result: unknown): void {
			const resolve = resolvePendingDialog;
			resolvePendingDialog = null;
			resolve?.(result);
		},
		/** Sends a key to the extension's terminal-input handler, as pi does before the focused overlay. */
		terminalInput: (data: string) => terminalInputHandler?.(data),
		emit,
		sessionStart: () => emit("session_start", { reason: "start" }),
		callTool: (name: string, params: unknown, id = "call", context: ExtensionContext = ctx) =>
			tools.get(name).execute(id, params, new AbortController().signal, undefined, context),
		runCommand: (name: string, args = "", context: ExtensionContext = ctx) => commands.get(name).handler(args, context),
	};
}

export type ExtensionHarness = ReturnType<typeof createExtensionHarness>;
