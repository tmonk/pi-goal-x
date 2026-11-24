/**
 * Reading what pi hands the extension: injected goal messages (which goal a
 * continuation marker names) and assistant turns (aborted, failed, transient
 * network errors, token use, meaningful progress tool calls).
 */

import { asRecord } from "./goal-record.ts";
import { GOAL_PROGRESS_TOOL_NAMES } from "./goal-tool-names.ts";

/**
 * Tools that count as "real work" toward the active goal. If a non-tool-use
 * turn ends without any of these having been called, we DO NOT queue the next
 * autoContinue — the agent was just chatting. This stops infinite chat loops.
 */
const GOAL_PROGRESS_TOOL_SET = new Set<string>(GOAL_PROGRESS_TOOL_NAMES);

/**
 * Issue #30 v2 markers are self-closing and carry an explicit version:
 * `<pi_goal_continuation goal_id="..." kind="checkpoint" v="2"/>`.
 */
function matchV2SelfClosingContinuation(text: string): string | null {
	const match = text.match(/^<pi_goal_continuation\s+goal_id="([^"]+)"[^>]*v="2"\s*\/?>/);
	return match?.[1] ?? null;
}

function matchLegacyContinuation(text: string): string | null {
	// Phase 5 C1: structured outer marker `<pi_goal_continuation goal_id="..." kind="...">`.
	// Borrowed from pi-codex-goal. More robust than bare bracket text because
	// the angle brackets + attributes are nearly impossible for users to type
	// by accident, and the structure is grep-able / parse-able by external tooling.
	const xmlMatch = text.match(/^<pi_goal_continuation\s+goal_id="([^"]+)"/);
	if (xmlMatch) return xmlMatch[1] ?? null;
	return null;
}

function matchLegacyBracketCheckpoint(text: string): string | null {
	const match = text.match(/^\[(?:GOAL CHECKPOINT|GOAL CONTINUATION|GOAL STALE) goalId=([^\]\s]+)\]/);
	return match?.[1] ?? null;
}

export function extractGoalIdFromInjectedMessage(text: string): string | null {
	return (
		matchV2SelfClosingContinuation(text)
		?? matchLegacyContinuation(text)
		?? matchLegacyBracketCheckpoint(text)
	);
}

export function isAbortedAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "aborted";
}

export function isErrorAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "error";
}

/**
 * Transient provider failures are safe for goal-level recovery backoff:
 * Pi-declared network errors plus HTTP 429/5xx-style outages surfaced by
 * providers (429 rate limits, 499 when a gateway loses the upstream, 503 server_error, HTTP/2 PROTOCOL_ERROR,
 * "Endpoint is unavailable", overloaded, gateway failures). Deliberately excludes auth and
 * malformed-request failures (and quota/billing text), which retrying
 * cannot fix.
 */
const TRANSIENT_PROVIDER_ERROR_RE = new RegExp(
	[
		"\\bnetwork[_\\s-]?error\\b",
		"\\bprotocol[_\\s-]?error\\b",
		"\\bserver[_\\s]?error\\b",
		"\\bfinish[_\\s-]?reason:\\s*error\\b",
		"\\b(?:429|499|502|503|504|529)\\b",
		"\\brate[_\\s-]?limited\\b",
		"\\brate[_\\s-]?limit\\b",
		"\\btoo many requests\\b",
		"\\bservice unavailable\\b",
		"\\bbad gateway\\b",
		"\\bgateway timeout\\b",
		"\\bupstream request failed\\b",
		"\\bendpoint is unavailable\\b",
		"\\boverloaded[_\\s]?error\\b",
	].join("|"),
	"i",
);

/** Quota/billing exhaustion is deterministic; retrying cannot fix it. */
const NON_TRANSIENT_PROVIDER_ERROR_RE = new RegExp(
	[
		"\\binsufficient[_\\s]?quota\\b",
		"\\bout of budget\\b",
		"\\bquota exceeded\\b",
		"\\bbilling\\b",
		"GoUsageLimitError",
		"FreeUsageLimitError",
	].join("|"),
	"i",
);

/** A transient provider failure is safe for the bounded goal backoff. */
export function isNetworkErrorAssistantMessage(message: unknown): boolean {
	if (!isErrorAssistantMessage(message)) return false;
	const raw = asRecord(message);
	const details = [raw?.rawStopReason, raw?.errorMessage]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
	// Quota/billing exhaustion is deterministic and must never be retried.
	if (NON_TRANSIENT_PROVIDER_ERROR_RE.test(details)) return false;
	return TRANSIENT_PROVIDER_ERROR_RE.test(details);
}

export function hasAbortedAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isAbortedAssistantMessage);
}

export function hasErrorAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isErrorAssistantMessage);
}

/** The provider's error text from the last failed assistant message, shortened for a notice. */
export function providerErrorText(messages: unknown[]): string | undefined {
	const failed = messages.filter(isErrorAssistantMessage).at(-1);
	const text = asRecord(failed)?.errorMessage;
	if (typeof text !== "string" || !text.trim()) return undefined;
	const line = text.trim().replace(/\s+/g, " ");
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function hasNetworkErrorAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isNetworkErrorAssistantMessage);
}

function usageChannelTokens(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

export function assistantTurnTokens(message: unknown): number {
	const raw = asRecord(message);
	if (!raw || raw.role !== "assistant") return 0;
	const usage = asRecord(raw.usage);
	if (!usage) return 0;
	return usageChannelTokens(usage.input) + usageChannelTokens(usage.output);
}

export function isMeaningfulProgressToolCall(toolName: string, args: unknown): boolean {
	if (!GOAL_PROGRESS_TOOL_SET.has(toolName)) return false;
	if (toolName === "read") {
		const path = asRecord(args)?.path;
		if (typeof path === "string" && (path === ".pi/goals" || path.startsWith(".pi/goals/"))) return false;
	}
	if (toolName === "bash") {
		const command = asRecord(args)?.command;
		if (typeof command === "string" && /^\s*echo\b/.test(command)) return false;
	}
	return true;
}
