/**
 * Issue #26 — opt-in read-only Blocker Oracle.
 *
 * A cheap executor can benefit from ONE stronger, read-only consultation
 * before giving up and asking the user. Hard safety properties (plan §64):
 *
 *   - disabled by default; requires an explicit resolvable provider/model;
 *   - invoked only through a valid update_goal({status:"blocked"}) request;
 *   - the nested session gets ONLY read/grep/find/ls + a structured submit
 *     tool — no write/edit/bash, ever;
 *   - one successful consultation per blocker fingerprint (usage, timestamps,
 *     and revision never change the fingerprint);
 *   - actionable advice keeps the goal ACTIVE and arms a follow-up marker;
 *     blocking is only permitted after a meaningful work attempt or when the
 *     Oracle concludes needs_human/insufficient_context;
 *   - every phase is durably recorded in the ledger with bounded payloads.
 */

import { Type } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";

import { defineTool, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { makeAuditorResourceLoader, resolveAuditorSessionModelOptions } from "./goal-auditor.ts";
import type { ResolvedGoalOracleSettings } from "./settings/schema.ts";
import { safeIdPart, type GoalRecord } from "./goal-record.ts";

function escapePromptPayload(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// ── blocker fingerprint ─────────────────────────────────────────────────────

function normalizeBlockerReason(reason: string): string {
	return reason.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Stable short hash over task-tree shape + contracts (not usage/timestamps). */
function taskStateFingerprint(goal: GoalRecord): string {
	const lines: string[] = [];
	const walk = (tasks: NonNullable<GoalRecord["taskList"]>["tasks"], depth: number): void => {
		for (const t of tasks) {
			lines.push(`${depth}:${t.id}:${t.status}:${t.verificationContract ?? ""}`);
			if (t.subtasks) walk(t.subtasks, depth + 1);
		}
	};
	if (goal.taskList) walk(goal.taskList.tasks, 0);
	return createHash("sha256").update(lines.join("|")).digest("hex").slice(0, 16);
}

interface BlockerFingerprintInput {
	goalId: string;
	objectiveHash: string;
	verificationContractHash: string;
	taskStateHash: string;
	currentTaskId?: string;
	normalizedReason: string;
}

/**
 * Distinguishes materially different blockers without changing when usage,
 * elapsed time, or revision counters change.
 */
export function buildBlockerFingerprint(goal: GoalRecord, reason: string): string {
	const input: BlockerFingerprintInput = {
		goalId: goal.id,
		objectiveHash: createHash("sha256").update(goal.objective).digest("hex").slice(0, 16),
		verificationContractHash: createHash("sha256").update(goal.verificationContract ?? "").digest("hex").slice(0, 16),
		taskStateHash: taskStateFingerprint(goal),
		currentTaskId: goal.currentTaskId,
		normalizedReason: normalizeBlockerReason(reason),
	};
	return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
}

// ── ledger reconstruction ───────────────────────────────────────────────────

export interface OracleConsultState {
	result?: { adviceId: string; disposition: "actionable" | "needs_human" | "insufficient_context"; summary: string };
	failedAttempts: number;
	lastFailure?: { errorCode: "config" | "provider" | "aborted" | "invalid_output"; message: string };
	followupAttempted: boolean;
}

// ── structured advice + isolated session ────────────────────────────────────

const OracleAdviceSchema = Type.Object({
	diagnosis: Type.String({ maxLength: 2000 }),
	alternatives: Type.Array(
		Type.Object({
			title: Type.String({ maxLength: 200 }),
			rationale: Type.String({ maxLength: 1000 }),
			steps: Type.Array(Type.String({ maxLength: 400 }), { minItems: 1, maxItems: 8 }),
			expectedEvidence: Type.Array(Type.String({ maxLength: 400 }), { maxItems: 8 }),
		}),
		{ minItems: 1, maxItems: 4 },
	),
	recommendedIndex: Type.Integer({ minimum: 0, maximum: 3 }),
	unresolvedQuestions: Type.Array(Type.String({ maxLength: 400 }), { maxItems: 6 }),
	disposition: Type.Union([
		Type.Literal("actionable"),
		Type.Literal("needs_human"),
		Type.Literal("insufficient_context"),
	]),
});

export type OracleAdvice = {
	diagnosis: string;
	alternatives: Array<{ title: string; rationale: string; steps: string[]; expectedEvidence: string[] }>;
	recommendedIndex: number;
	unresolvedQuestions: string[];
	disposition: "actionable" | "needs_human" | "insufficient_context";
};

type OracleRunResult =
	| { ok: true; advice: OracleAdvice }
	| { ok: false; errorCode: "config" | "provider" | "aborted" | "invalid_output"; message: string };

function buildBlockerOraclePrompt(args: {
	goal: GoalRecord;
	reason: string;
	attemptedActions: string[];
	recentEvidence: string;
}): string {
	const g = args.goal;
	return [
		"You are a read-only blocker adviser.",
		"Find concrete alternative paths. Do not mutate files.",
		"Do not mark the goal complete or blocked.",
		"Return advice only through submit_goal_oracle_advice.",
		"",
		"<objective>",
		escapePromptPayload(g.objective),
		"</objective>",
		g.verificationContract?.trim() ? `<verification_contract>\n${escapePromptPayload(g.verificationContract.trim())}\n</verification_contract>` : "",
		`<blocker_reason>\n${escapePromptPayload(args.reason)}\n</blocker_reason>`,
		args.attemptedActions.length > 0 ? `<attempted_actions>\n${args.attemptedActions.map((a) => `- ${a}`).join("\n")}\n</attempted_actions>` : "",
		args.recentEvidence.trim() ? `<recent_evidence>\n${escapePromptPayload(args.recentEvidence.slice(0, 2000))}\n</recent_evidence>` : "",
		"",
		"Inspect relevant files with read-only tools before advising when needed.",
	].filter(Boolean).join("\n\n");
}

/** Validate untrusted submitted advice against the bounded schema semantics. */
function validateAdvice(value: unknown): OracleAdvice | { error: string } {
	const raw = value as Record<string, unknown> | null;
	if (!raw || typeof raw !== "object") return { error: "advice must be an object" };
	if (typeof raw.diagnosis !== "string" || !raw.diagnosis.trim()) return { error: "diagnosis required" };
	if (!Array.isArray(raw.alternatives) || raw.alternatives.length < 1 || raw.alternatives.length > 4) {
		return { error: "1-4 alternatives required" };
	}
	for (const alt of raw.alternatives as Array<Record<string, unknown>>) {
		if (typeof alt.title !== "string" || typeof alt.rationale !== "string") return { error: "alternative title/rationale required" };
		if (!Array.isArray(alt.steps) || alt.steps.length < 1 || alt.steps.some((s) => typeof s !== "string")) return { error: "steps must be non-empty strings" };
	}
	if (typeof raw.recommendedIndex !== "number" || raw.recommendedIndex < 0 || raw.recommendedIndex >= (raw.alternatives as unknown[]).length) {
		return { error: "recommendedIndex out of range" };
	}
	if (raw.disposition !== "actionable" && raw.disposition !== "needs_human" && raw.disposition !== "insufficient_context") {
		return { error: "disposition must be actionable|needs_human|insufficient_context" };
	}
	return value as OracleAdvice;
}

/** Resolve the EXPLICIT Oracle model; provider-only or missing config is refused. */
export function resolveOracleModel(
	ctx: ExtensionContext,
	settings: ResolvedGoalOracleSettings,
): { ok: true; model: unknown } | { ok: false; message: string } {
	if (!settings.provider || !settings.model) {
		return {
			ok: false,
			message: "The blocker Oracle is enabled but not fully configured: set both oracle.provider and oracle.model in settings. The executor model is NOT used silently.",
		};
	}
	const found = (ctx.modelRegistry as unknown as { find?: (provider: string, id: string) => unknown })?.find?.(settings.provider, settings.model);
	if (!found) {
		return { ok: false, message: `Configured Oracle model not found: ${settings.provider}/${settings.model}.` };
	}
	return { ok: true, model: found };
}

/**
 * Run ONE isolated read-only Oracle consultation. `createSession` is
 * injectable for tests (same seam as the completion auditor).
 */
export async function runBlockerOracle(args: {
	ctx: ExtensionContext;
	goal: GoalRecord;
	reason: string;
	attemptedActions: string[];
	settings: ResolvedGoalOracleSettings;
	recentEvidence: string;
	signal?: AbortSignal;
	createSession?: (...args: unknown[]) => Promise<{ session: OracleSessionFactory }>;
}): Promise<OracleRunResult> {
	const model = resolveOracleModel(args.ctx, args.settings);
	if (!model.ok) return { ok: false, errorCode: "config", message: model.message };

	const submitted: { settled: boolean; advice?: OracleAdvice } = { settled: false };
	const submitTool = defineTool({
		name: "submit_goal_oracle_advice",
		label: "Submit Oracle Advice",
		description: "Submit your structured blocker advice. This is the ONLY way to return a result.",
		promptSnippet: "Submit structured advice via submit_goal_oracle_advice.",
		parameters: OracleAdviceSchema,
		async execute(_toolCallId, params) {
			const validated = validateAdvice(params);
			if ("error" in validated) {
				return { content: [{ type: "text", text: `Invalid advice: ${validated.error}` }], details: {} };
			}
			submitted.advice = validated;
			submitted.settled = true;
			return { content: [{ type: "text", text: "Advice recorded." }], details: {} };
		},
	});

	try {
		const createSession = args.createSession ?? (await import("@earendil-works/pi-coding-agent")).createAgentSession as unknown as (...sessionArgs: unknown[]) => Promise<{ session: OracleSessionFactory }>;
		// Read-only tool profile: NO bash/write/edit is exposed to the Oracle.
		const { session } = await createSession({
			cwd: args.ctx.cwd,
			model: model.model,
			thinkingLevel: args.settings.thinkingLevel,
			...resolveAuditorSessionModelOptions(args.ctx),
			sessionManager: SessionManager.inMemory(args.ctx.cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			...(!args.settings.projectResources ? { resourceLoader: makeAuditorResourceLoader(
				"You are a read-only blocker adviser. Inspect evidence and suggest concrete alternative paths. Never modify files or decide goal outcomes. Return advice through submit_goal_oracle_advice.",
			) } : {}),
			tools: ["read", "grep", "find", "ls", "submit_goal_oracle_advice"],
			customTools: [submitTool],
		});

		const abort = () => session.abort();
		args.signal?.addEventListener("abort", abort, { once: true });
		try {
			if (args.signal?.aborted) return { ok: false, errorCode: "aborted", message: "Oracle consultation aborted." };
			await session.prompt(buildBlockerOraclePrompt({
				goal: args.goal,
				reason: args.reason,
				attemptedActions: args.attemptedActions.slice(0, 8),
				recentEvidence: args.recentEvidence,
			}));
		} finally {
			args.signal?.removeEventListener("abort", abort);
			session.dispose?.();
		}

		if (args.signal?.aborted) return { ok: false, errorCode: "aborted", message: "Oracle consultation aborted." };
		if (!submitted.settled || !submitted.advice) {
			return { ok: false, errorCode: "invalid_output", message: "Oracle returned no structured advice." };
		}
		return { ok: true, advice: submitted.advice };
	} catch (error) {
		if (args.signal?.aborted) return { ok: false, errorCode: "aborted", message: "Oracle consultation aborted." };
		return { ok: false, errorCode: "provider", message: error instanceof Error ? error.message : String(error) };
	}
}

type OracleSessionFactory = {
	prompt: (promptText: string) => Promise<void>;
	abort: () => void;
	dispose?: () => void;
	subscribe?: (listener: (event: unknown) => void) => () => void;
};

// ── armed follow-up marker (session-scoped) ────────────────────────────────

interface ArmedAdvice {
	goalId: string;
	fingerprint: string;
	adviceId: string;
	text: string;
}

const armedByGoalId = new Map<string, ArmedAdvice>();

export function armOracleAdvice(goalId: string, fingerprint: string, advice: OracleAdvice): string {
	const adviceId = `${fingerprint}-${safeIdPart(advice.alternatives[advice.recommendedIndex]?.title ?? "advice").slice(0, 24)}`;
	const recommended = advice.alternatives[advice.recommendedIndex]!;
	armedByGoalId.set(goalId, {
		goalId,
		fingerprint,
		adviceId,
		text: [
			"Oracle suggested an alternative path:",
			`${recommended.title} — ${recommended.rationale}`,
			"Steps:",
			...recommended.steps.map((s, i) => `  ${i + 1}. ${s}`),
			recommended.expectedEvidence.length > 0 ? `Expected evidence: ${recommended.expectedEvidence.join("; ")}` : "",
			"Attempt this path before reporting blocked again.",
		].filter(Boolean).join("\n"),
	});
	return adviceId;
}

export function hasPendingOracleAdviceForFocusedGoal(goalId: string): boolean {
	return armedByGoalId.has(goalId);
}

/** Consume the armed marker after a meaningful work attempt. */
export function consumeOracleFollowupMarker(goalId: string): ArmedAdvice | undefined {
	const armed = armedByGoalId.get(goalId);
	armedByGoalId.delete(goalId);
	return armed;
}

export function renderActionableOracleAdvice(advice: OracleAdvice): string {
	const recommended = advice.alternatives[advice.recommendedIndex]!;
	return [
		`Oracle diagnosis: ${advice.diagnosis}`,
		`Recommended alternative: ${recommended.title} — ${recommended.rationale}`,
		...recommended.steps.map((s, i) => `  ${i + 1}. ${s}`),
		"Try this path before calling update_goal({status:\"blocked\"}) again.",
	].join("\n");
}

export function renderOracleAdviceReminder(armed: ArmedAdvice): string {
	return `${armed.text}\n(The same blocker fingerprint already received Oracle advice; no new consultation will run until you attempt it.)`;
}
