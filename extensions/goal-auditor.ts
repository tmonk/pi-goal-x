import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type AgentSessionEvent,
	type ExtensionContext,
	type ModelRuntime,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { GoalRecord } from "./goal-record.ts";
import { buildGoalAuditorPrompt } from "./goal-auditor-prompt.ts";
import { type GoalSettings, type ThinkingLevel } from "./settings/schema.ts";
import { loadGoalSettings } from "./settings/resolve.ts";

export { buildGoalAuditorPrompt };

export interface AuditorProgress {
	/** Current tool being executed by the auditor, if any */
	currentTool?: string;
	/** Arguments passed to the current tool (truncated for display) */
	currentToolArgs?: string;
	/** When the current tool started (ms since epoch) */
	currentToolStartedAt?: number;
	/** Recent text output lines from the auditor's assistant messages */
	recentOutput: string[];
	/** Phase of the audit */
	phase: "running" | "tool_executing" | "producing_report" | "thinking" | "done";
	/** Elapsed ms since audit started */
	elapsedMs: number;
	/** Current step label shown to the user (e.g. "Inspecting files...") */
	label?: string;
	/** Completion percentage from 0 to 100 */
	percentage?: number;
}

type AuditorProgressCallback = (progress: AuditorProgress) => void;

export interface GoalAuditorResult {
	approved: boolean;
	disapproved: boolean;
	output: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	error?: string;
}

export function parseAuditorDecision(output: string): { approved: boolean; disapproved: boolean } {
	// The prompt contract: the verdict marker must be the FINAL line of the
	// report. Matching anywhere lets a prose mention of the marker (e.g. "I
	// would only emit <approved/> if ...") be misread as the verdict.
	const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
	const marker = lines[lines.length - 1];
	return { approved: marker === "<approved/>", disapproved: marker === "<disapproved/>" };
}

/** Stream previews need only the tail, not a split/copy of the full growing report. */
export function recentNonEmptyLines(text: string, limit: number): string[] {
	const lines: string[] = [];
	let end = text.length;
	while (end >= 0 && lines.length < limit) {
		const newline = end > 0 ? text.lastIndexOf("\n", end - 1) : -1;
		const line = text.slice(newline + 1, end);
		if (line.trim()) lines.push(line);
		if (newline < 0) break;
		end = newline;
	}
	return lines.reverse();
}

/** Display label and rough phase estimate for each of the auditor's read-only tools. */
const READ_ONLY_TOOL_PROGRESS: Record<string, { label: string; percentage: number }> = {
	read: { label: "Inspecting files...", percentage: 25 },
	ls: { label: "Listing directory...", percentage: 25 },
	find: { label: "Locating files...", percentage: 25 },
	grep: { label: "Searching content...", percentage: 50 },
	bash: { label: "Running verification commands...", percentage: 75 },
};

export function makeAuditorResourceLoader(systemPrompt = [
	"You are a read-only completion auditor running in an isolated pi agent session.",
	"Inspect the repository and decide whether the claimed goal completion is genuinely satisfied.",
	"Never modify files. Never approve unless the actual user objective is complete.",
].join("\n")): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi SDK types Model<any> idiomatically (pi-coding-agent sdk.d.ts)
export function resolveAuditorModel(ctx: ExtensionContext, config: GoalSettings): { model: Model<any> | undefined; error?: string } {
	const { provider, model: modelName } = config;
	if (provider && modelName) {
		const model = ctx.modelRegistry.find(provider, modelName);
		return model ? { model } : { model: undefined, error: `Configured auditor model not found: ${provider}/${modelName}` };
	}
	if (provider) {
		// Refuse provider-only config: silently picking the first available model
		// hides misconfiguration. An explicit provider/model is required.
		return {
			model: undefined,
			error: `Provider-only auditor configuration is refused; select an explicit model for provider: ${provider}`,
		};
	}
	if (!modelName) return { model: ctx.model };
	const slash = modelName.indexOf("/");
	if (slash > 0) {
		const model = ctx.modelRegistry.find(modelName.slice(0, slash), modelName.slice(slash + 1));
		return model ? { model } : { model: undefined, error: `Configured auditor model not found: ${modelName}` };
	}
	const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === modelName || model.name === modelName);
	if (matches.length === 1) return { model: matches[0] };
	return { model: undefined, error: `Configured auditor model is ambiguous or unavailable: ${modelName}` };
}

/**
 * Options that reuse the parent session's auth + registered providers for the nested auditor.
 *
 * Pi 1.4's extension ModelRegistry wraps the live ModelRuntime.
 * Sharing that runtime keeps extension providers such as `pi-cursor-sdk`'s `cursor`
 * provider (and its auth) available. Without this, the auditor builds a fresh runtime
 * with an empty resource loader, so Cursor models fail with "No API key found for cursor"
 * even when `~/.pi/agent/auth.json` has a Cursor key.
 */
export function resolveAuditorSessionModelOptions(ctx: ExtensionContext): { modelRuntime?: ModelRuntime } {
	const registry = ctx.modelRegistry as unknown as { runtime?: ModelRuntime } | undefined;
	return { modelRuntime: registry?.runtime };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi SDK types Model<any> idiomatically (pi-coding-agent sdk.d.ts)
function modelLabel(model: Model<any> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

/** Live progress of one audit, derived from the auditor session's events, plus the report text it produces. */
function createAuditProgress(onProgress: AuditorProgressCallback | undefined) {
	const startedAt = Date.now();
	const progress: AuditorProgress = { recentOutput: [], phase: "running", elapsedMs: 0 };
	const outputParts: string[] = [];
	let outputTail: string[] = [];

	function emit(): void {
		progress.elapsedMs = Date.now() - startedAt;
		onProgress?.({ ...progress });
	}

	type MessageLike = { role?: string; content?: Array<{ type?: string; text?: string }> };

	return {
		/** The report text produced so far. */
		outputText: () => outputParts.join("\n\n").trim(),

		start(): void {
			progress.label = "Starting audit...";
			progress.percentage = 0;
			emit();
		},

		finish(): void {
			progress.phase = "done";
			progress.label = "Audit complete.";
			progress.percentage = 100;
			emit();
		},

		/** Progress is derived from session events — no model-facing progress tool exists. */
		onEvent(event: AgentSessionEvent): void {
			if (event.type === "agent_start") {
				progress.label = "Starting audit...";
				progress.percentage = 0;
				progress.phase = "running";
				emit();
				return;
			}
			if (event.type === "tool_execution_start") {
				progress.currentTool = event.toolName;
				progress.currentToolArgs = typeof event.args === "object" && event.args !== null
					? JSON.stringify(event.args).slice(0, 120)
					: String(event.args ?? "").slice(0, 120);
				progress.currentToolStartedAt = Date.now();
				progress.phase = "tool_executing";
				const known = READ_ONLY_TOOL_PROGRESS[event.toolName];
				progress.label = known?.label ?? `Inspecting (${event.toolName})...`;
				progress.percentage = Math.max(progress.percentage ?? 0, known?.percentage ?? 25);
				emit();
				return;
			}
			if (event.type === "tool_execution_end") {
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.phase = "running";
				emit();
				return;
			}
			if (event.type === "message_update") {
				// Check for thinking events from the assistant stream
				const streamEvent = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent;
				if (streamEvent?.type === "thinking_start") {
					progress.phase = "thinking";
					if (!progress.label) progress.label = "Analyzing goal...";
					emit();
					return;
				}
				if (streamEvent?.type === "thinking_end") {
					progress.phase = "running";
					emit();
					return;
				}
				// For text content, show producing_report phase
				progress.phase = "producing_report";
				const message = event.message as MessageLike;
				if (message?.role === "assistant") {
					for (const part of message.content ?? []) {
						if (part.type === "text" && typeof part.text === "string") {
							// Keep the last 5 non-empty text lines for live display
							const lines = recentNonEmptyLines(part.text, 5);
							if (lines.length) progress.recentOutput = lines;
						}
					}
				}
				emit();
				return;
			}
			if (event.type !== "message_end") return;
			const message = event.message as MessageLike;
			if (message.role !== "assistant") return;
			for (const part of message.content ?? []) {
				if (part.type === "text" && typeof part.text === "string") {
					outputParts.push(part.text);
					outputTail = [...outputTail, ...recentNonEmptyLines(part.text, 8)].slice(-8);
				}
			}
			// Final report production: derived label for the widget.
			if (outputTail.length > 0) {
				progress.label = "Producing report...";
				progress.percentage = Math.max(progress.percentage ?? 0, 90);
				progress.phase = "producing_report";
			}
			// Show the accumulated output in progress
			progress.recentOutput = outputTail;
			emit();
		},
	};
}

export async function runGoalCompletionAuditor(args: {
	ctx: ExtensionContext;
	goal: GoalRecord;
	detailedSummary: string;
	completionSummary?: string | null;
	settings?: GoalSettings;
	/** P1-6: parent-rendered evidence (ledger tail + turn trail). */
	warmContext?: string | null;
	signal?: AbortSignal;
	onProgress?: AuditorProgressCallback;
	/**
	 * Optional factory for creating the auditor agent session.
	 * Exposed for testing so a mock/controllable session can be injected.
	 * Defaults to the real createAgentSession from @earendil-works/pi-coding-agent.
	 */
	createSession?: typeof createAgentSession;
}): Promise<GoalAuditorResult> {
	const config = loadGoalSettings(args.ctx.cwd);
	const resolved = resolveAuditorModel(args.ctx, config);
	const model = resolved.model;
	const thinkingLevel = config.thinkingLevel;
	const failure = (output: string, error: string): GoalAuditorResult =>
		({ approved: false, disapproved: true, output, model: modelLabel(model), thinkingLevel, error });
	if (resolved.error) return failure("", resolved.error);
	const audit = createAuditProgress(args.onProgress);
	try {
		const createSession = args.createSession ?? createAgentSession;
		const projectResources = args.settings?.auditorProjectResources === true;
		const { session } = await createSession({
			cwd: args.ctx.cwd,
			model,
			thinkingLevel,
			...resolveAuditorSessionModelOptions(args.ctx),
			// E3: default = the empty isolated loader (deliberate isolation);
			// when auditorProjectResources is on, let the runtime build its own
			// loader so the project's skills/extensions reach the auditor.
			...(projectResources
				? { resourceLoaderOptions: { noExtensions: false, noSkills: false, noPromptTemplates: false, noThemes: false, noContextFiles: false } }
				: { resourceLoader: makeAuditorResourceLoader() }),
			sessionManager: SessionManager.inMemory(args.ctx.cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			tools: ["read", "grep", "find", "ls", "bash"],
		} as Parameters<typeof createAgentSession>[0]);
		const unsubscribe = session.subscribe((event) => audit.onEvent(event));
		// Wire the external AbortSignal to abort the running session when fired
		// This is the mechanism that makes Esc-to-skip actually stop the auditor.
		const abortSession = () => { session.abort(); };
		args.signal?.addEventListener("abort", abortSession, { once: true });

		audit.start();
		try {
			if (args.signal?.aborted) return failure("", "Auditor aborted.");
			await session.prompt(buildGoalAuditorPrompt(args));
		} finally {
			args.signal?.removeEventListener("abort", abortSession);
			audit.finish();
			unsubscribe();
			session.dispose?.();
		}
		// session.abort() does NOT throw — the agent loop returns normally with
		// whatever output was captured before the abort. Check the signal after
		// prompt completes and treat any abort as auditor-aborted regardless of
		// whether an exception propagated.
		if (args.signal?.aborted) return failure(audit.outputText(), "Auditor aborted.");
		const output = audit.outputText();
		return { ...parseAuditorDecision(output), output, model: modelLabel(model), thinkingLevel };
	} catch (error) {
		const isAborted = args.signal?.aborted || (error instanceof Error && error.name === "AbortError");
		return failure(audit.outputText(), isAborted ? "Auditor aborted." : (error instanceof Error ? error.message : String(error)));
	}
}
