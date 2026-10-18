import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_AUDIT_ENTRY, goalEventMessageId } from "./goal-format.ts";

/** pi-subagents marks fresh, forked, resumed and nested worker processes. */
export function isDelegatedGoalSession(env: Record<string, string | undefined> = process.env): boolean {
	const depth = Number(env.PI_SUBAGENT_DEPTH);
	return env.PI_SUBAGENT_CHILD === "1" || (Number.isFinite(depth) && depth > 0);
}

/** Display-only audits must never become user messages between a tool and its result. */
export function filterGoalSessionContext<T>(messages: readonly T[], child = false): T[] | null {
	let filtered: T[] | null = null;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		const entry = message as { role?: string; customType?: string; details?: unknown; content?: unknown } | null;
		const remove = entry && typeof entry === "object" && entry.role === "custom"
			&& (entry.customType === GOAL_AUDIT_ENTRY || (child && goalEventMessageId(entry) !== null));
		if (remove) filtered ??= messages.slice(0, i);
		else filtered?.push(message);
	}
	return filtered;
}

/**
 * Register a request-only transcript transform; return null to leave the request unchanged.
 *
 * Pi 0.87+ dispatches `context_with_system` after `context`. Transforming there keeps
 * mid-transcript system messages (prompt-section and tool deltas) in place. A changed
 * `context` result instead makes Pi fold them into the leading system message, which
 * rewrites the provider's cached prompt prefix every time the prompt changes.
 * Older Pi only has `context`, so it stays the fallback. On newer Pi it handles just the
 * first request, before Pi's first `context_with_system` dispatch shows support.
 */
export function registerContextTransform(
	pi: ExtensionAPI,
	transform: (messages: unknown[], ctx: ExtensionContext) => unknown[] | null,
): void {
	let withSystem = false;
	let handled = false;
	pi.on("context", async (event, ctx) => {
		if (withSystem) return undefined;
		handled = true;
		const messages = transform(event.messages, ctx);
		return messages === null ? undefined : { messages: messages as typeof event.messages };
	});
	// Untyped: the event is missing from Pi 0.83-0.86 declarations, which the package still supports.
	const on = pi.on.bind(pi) as unknown as (event: string, handler: (event: { messages: unknown[] }, ctx: ExtensionContext) => unknown) => unknown;
	on("context_with_system", async (event, ctx) => {
		withSystem = true;
		if (handled) { handled = false; return undefined; }
		const messages = transform(event.messages, ctx);
		return messages === null ? undefined : { messages };
	});
}

type TranscriptMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
type SessionKey = string | ExtensionContext["sessionManager"];
const sessionKey = (ctx: ExtensionContext): SessionKey => ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager;

/** Transcript output waits for the entire agent run, including tool results, to settle. */
export class GoalAuditMessages {
	private pending: { session: SessionKey; message: TranscriptMessage }[] = [];

	enqueue(ctx: ExtensionContext, message: TranscriptMessage): void {
		this.pending.push({ session: sessionKey(ctx), message });
	}

	clear(): void {
		this.pending = [];
	}

	flush(ctx: ExtensionContext, pi: ExtensionAPI): void {
		const session = sessionKey(ctx);
		this.pending = this.pending.filter(item => item.session === session);
		if (!ctx.isIdle()) return;
		const pending = this.pending;
		this.pending = [];
		for (const item of pending) pi.sendMessage(item.message, { triggerTurn: false });
	}
}
