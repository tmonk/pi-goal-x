import { hash } from "node:crypto";
import { asRecord } from "./goal-record.ts";

/**
 * Prefix-stable retention for request-only goal-state tails.
 *
 * The context hook appends live goal state to every provider request without
 * persisting it. When the next request arrives, the completed assistant turn
 * occupies the position where the previous tail sat, so request N is no
 * longer a prefix of request N+1 and implicit prompt caches (OpenAI Responses
 * / Chat Completions, which carry no explicit marker) freeze at the first
 * injection point.
 *
 * This module makes each request a true prefix of the next: previously sent
 * tails are re-inserted verbatim at their recorded anchor (the session length
 * when they were emitted), the whole preceding history is verified unchanged
 * by digest, and only genuinely new tail content is appended. Identical
 * content across repeated requests appends nothing, so tool loops and idle
 * re-requests cost zero growth.
 *
 * Three kinds of text go through here, by how often they change:
 * - state: the goal policy (rules, objective, contract, status). A change is
 *   appended as a new block that says it supersedes the earlier ones, so the
 *   cached prefix survives pause, resume and settings changes.
 * - counters: the task list snapshot. A change appends a new snapshot.
 * - ephemeral: usage, run counts and notes that are cleared by omission
 *   (scheduling waits, stall notes, one-shot reminders). It rides at the end of
 *   each request and is never retained, so nothing stale is left in history.
 *
 * A change of scope (a different goal), any history rewrite (compaction,
 * resume, session-tree moves, filter changes, middle-message edits), an unsafe
 * insertion point, or overflow performs one documented full reset instead of
 * silently shifting the prefix or corrupting message structure.
 */

const LIVE_CONTEXT_TYPE = "pi-goal-live-context";

type LiveTailKind = "goal-state" | "goal-counters";

/** A request-only tail message. Never persisted; the hook replays it per request. */
interface LiveMessage {
	role: "custom";
	customType: typeof LIVE_CONTEXT_TYPE;
	content: string;
	display: false;
	timestamp: 0;
}

/**
 * Upper bound on retained tails per session. Retained tails are small (policy
 * blocks and task snapshots), so the steady-state wire overhead stays near a
 * few kilobytes; exceeding the bound performs a single full reset, i.e. at
 * most one prefix break per MAX_RETAINED_LIVE_TAILS changes.
 */
export const MAX_RETAINED_LIVE_TAILS = 48;

/**
 * Upper bound on policy blocks kept in history. Each change appends a block
 * that supersedes the earlier ones; past this many, one reset removes them.
 */
export const MAX_RETAINED_POLICY_BLOCKS = 12;

/** Said once at the top of every policy block that follows an earlier one. */
export const POLICY_SUPERSEDED_NOTE = "[This is the current goal policy. It supersedes every earlier [PI GOAL …] block above; follow only this one.]";

/** Sent with every request while superseded policy blocks remain in history. */
export const POLICY_RECENCY_NOTE = "Only the latest goal policy block above applies; earlier goal policy blocks are superseded.";

/** Upper bound on concurrently tracked sessions (parent plus isolated runs). */
const MAX_TRACKED_SESSIONS = 16;
/**
 * Extra historical snapshots (the task list), excluding policy blocks. Past
 * this a full reset happens. Old snapshots are cheap cached tokens; a reset
 * re-sends the whole history since the first anchor uncached, so this is sized
 * to hold the task-list updates of a long goal.
 */
export const MAX_RETAINED_COUNTER_BYTES = 24576;

export interface FreshLiveTails {
	/** Goal policy. Retained; a change is appended and supersedes earlier blocks. */
	state: string;
	/** Task list snapshot. Retained; a change appends a new snapshot. */
	counters?: string | undefined;
	/** Request-only text for this request, never retained: usage, runs, notes cleared by omission. */
	ephemeral?: string | undefined;
	/** What the goal is about (usually the goal id). A different scope starts over. */
	scope?: string | undefined;
}

interface RetainedTail {
	anchorIndex: number;
	/** The message the tail follows, as it was when the tail was added. */
	anchorSnapshot: Snapshot | null;
	content: string;
	kind: LiveTailKind;
}

interface SessionRetention {
	tails: RetainedTail[];
	lastFresh: { state: string; counters: string | undefined; countersState: string | undefined; scope: string | undefined } | undefined;
	/** The request-only text sent last, so the explicit-cache marker can skip it. */
	lastEphemeral: string | undefined;
	/** Every base message as it was at the last apply; any earlier rewrite resets. */
	baseSnapshots: Array<Snapshot | null>;
}


/**
 * A message as it looked at the last request, kept to compare against the next
 * one. Short strings are kept as they are; long ones as a length and a hash, so
 * the copy stays small and big tool results are not held twice. Null means the
 * message could not be copied, and a null never matches anything.
 */
type Snapshot = unknown;

/** Strings up to this long are kept as they are. Longer ones are hashed. */
const RAW_STRING_MAX = 4096;
/** Deeper than any real message. Guards against cycles. */
const MAX_DEPTH = 64;

class LongString {
	readonly length: number;
	readonly hash: string;
	constructor(length: number, hash: string) {
		this.length = length;
		this.hash = hash;
	}
}

const hashText = (text: string): string => hash("sha256", text, "base64");

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function copyForComparison(value: unknown, depth: number): Snapshot {
	if (typeof value === "string") return value.length > RAW_STRING_MAX ? new LongString(value.length, hashText(value)) : value;
	if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
	if (depth >= MAX_DEPTH || typeof value !== "object") throw new Error("not copyable");
	if (Array.isArray(value)) return value.map(item => copyForComparison(item, depth + 1));
	if (!isPlainObject(value)) throw new Error("not copyable");
	const copy: Record<string, Snapshot> = {};
	for (const key of Object.keys(value)) copy[key] = copyForComparison((value as Record<string, unknown>)[key], depth + 1);
	return copy;
}

function snapshotMessage(message: unknown): Snapshot | null {
	try {
		return copyForComparison(message, 0);
	} catch {
		return null;
	}
}

function sameAsSnapshot(snapshot: Snapshot, value: unknown, depth = 0): boolean {
	if (typeof snapshot === "string") return snapshot === value;
	if (snapshot instanceof LongString) return typeof value === "string" && value.length === snapshot.length && hashText(value) === snapshot.hash;
	if (snapshot === null || typeof snapshot !== "object") return Object.is(snapshot, value);
	if (depth >= MAX_DEPTH || typeof value !== "object" || value === null) return false;
	if (Array.isArray(snapshot)) {
		if (!Array.isArray(value) || value.length !== snapshot.length) return false;
		for (let i = 0; i < snapshot.length; i++) if (!sameAsSnapshot(snapshot[i], value[i], depth + 1)) return false;
		return true;
	}
	if (Array.isArray(value) || !isPlainObject(value)) return false;
	const keys = Object.keys(snapshot);
	if (Object.keys(value).length !== keys.length) return false;
	for (const key of keys) {
		if (!Object.hasOwn(value, key) || !sameAsSnapshot((snapshot as Record<string, Snapshot>)[key], (value as Record<string, unknown>)[key], depth + 1)) return false;
	}
	return true;
}

/** True when the message is unchanged since the snapshot was taken. */
const unchanged = (snapshot: Snapshot | null, message: unknown): boolean => snapshot !== null && sameAsSnapshot(snapshot, message);

/**
 * Tool results must stay adjacent to the call they answer, so a retained tail
 * may never be inserted directly before one. Covers the Pi session role
 * (`toolResult`), the provider wire role (`tool`, as seen by marker
 * relocation), and result-bearing content blocks in either vocabulary — the
 * call side needs no guard since inserting before a call keeps the pair
 * adjacent.
 */
function splitsToolBatch(next: unknown): boolean {
	const record = asRecord(next);
	const role = record?.role;
	if (role === "toolResult" || role === "tool") return true;
	const content = record?.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			const entry = asRecord(block);
			if (!entry) continue;
			const type = typeof entry.type === "string" ? entry.type : "";
			if (type === "tool_result" || type === "toolResult") return true;
			if ("toolCallId" in entry || "toolUseId" in entry) return true;
		}
	}
	return false;
}

function makeLiveMessage(content: string): LiveMessage {
	return {
		role: "custom",
		customType: LIVE_CONTEXT_TYPE,
		content,
		display: false,
		timestamp: 0,
	};
}

export class LiveTailRetention {
	private readonly sessions = new Map<string, SessionRetention>();

	apply<T>(sessionKey: string, base: readonly T[], fresh: FreshLiveTails | null): { messages: Array<T | LiveMessage>; transientContents: string[]; stableLength: number } {
		if (fresh === null) {
			this.sessions.delete(sessionKey);
			return { messages: [...base], transientContents: [], stableLength: base.length };
		}
		let session = this.sessions.get(sessionKey);
		if (!session) {
			session = { tails: [], lastFresh: undefined, lastEphemeral: undefined, baseSnapshots: [] };
			if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
				const oldest = this.sessions.keys().next();
				if (!oldest.done) this.sessions.delete(oldest.value);
			}
			this.sessions.set(sessionKey, session);
		}
		const reset = () => {
			session!.tails = [];
			session!.lastFresh = undefined;
			session!.baseSnapshots = [];
		};
		// A different goal (or a stale-checkpoint or unfocused state) shares
		// nothing with the earlier blocks, so start over.
		if (session.lastFresh !== undefined && session.lastFresh.scope !== fresh.scope) reset();
		// A task list that disappears under the same policy it was sent with
		// would leave the old list in history with nothing to supersede it. Under
		// a different policy (paused, blocked) the new block takes over.
		if (session.lastFresh?.counters !== undefined && fresh.counters === undefined && session.lastFresh.countersState === fresh.state) reset();
		// Tails anchored while history was empty would linger at the head once
		// real history arrives. Reset once so fresh tails anchor at the tail.
		if (session.tails.length > 0 && session.baseSnapshots.length === 0 && base.length > 0) reset();
		// Any rewrite earlier than the anchors — middle-message edits, filter
		// changes, checkpoint normalization — breaks the prefix even when the
		// trailing message is identical, so verify the whole preceding history.
		// Pi hands every request a fresh copy of the messages, and extensions may
		// edit them, so the check compares content with what was seen last time.
		// Comparing is much cheaper than hashing every message on every request.
		if (session.baseSnapshots.length > base.length) reset();
		else {
			for (let i = 0; i < session.baseSnapshots.length; i++) {
				if (!unchanged(session.baseSnapshots[i] ?? null, base[i])) {
					reset();
					break;
				}
			}
		}
		// The verified history keeps its snapshots; only new messages are copied.
		const snapshots = session.baseSnapshots;
		for (let i = snapshots.length; i < base.length; i++) snapshots.push(snapshotMessage(base[i]));
		// An unsafe anchor invalidates the whole replay. Keeping an earlier
		// policy while re-appending fresh blocks would duplicate that policy.
		let valid = 0;
		while (valid < session.tails.length) {
			const tail = session.tails[valid]!;
			if (tail.anchorIndex > base.length) break;
			if (tail.anchorIndex > 0) {
				if (!unchanged(tail.anchorSnapshot, base[tail.anchorIndex - 1])) break;
			}
			if (splitsToolBatch(base[tail.anchorIndex])) break;
			valid++;
		}
		if (valid < session.tails.length) reset();
		// Append only what differs from the last emitted blocks, so unchanged
		// content across repeats, tool loops, and history advances adds zero
		// blocks while keeping the prefix literal. Overflow is measured against
		// what this request actually appends: an unchanged request adds nothing
		// and must never trigger a reset.
		const counterBytes = () => session!.tails.filter(tail => tail.kind === "goal-counters").reduce((n, tail) => n + Buffer.byteLength(tail.content), 0);
		const changes = () => {
			const last = session!.lastFresh;
			return {
				policy: last === undefined || last.state !== fresh.state,
				counters: fresh.counters !== undefined && (last === undefined || last.counters !== fresh.counters),
			};
		};
		let changed = changes();
		const policyBlocks = session.tails.filter(tail => tail.kind === "goal-state").length;
		if (session.tails.length + Number(changed.policy) + Number(changed.counters) > MAX_RETAINED_LIVE_TAILS
			|| (changed.policy && policyBlocks >= MAX_RETAINED_POLICY_BLOCKS)
			|| (changed.counters && counterBytes() + Buffer.byteLength(fresh.counters!) > MAX_RETAINED_COUNTER_BYTES)) {
			reset();
			changed = changes();
		}
		const messages: Array<T | LiveMessage> = [...base];
		for (let i = session.tails.length - 1; i >= 0; i--) {
			const tail = session.tails[i]!;
			messages.splice(tail.anchorIndex, 0, makeLiveMessage(tail.content));
		}
		const anchorSnapshot = snapshots.at(-1) ?? null;
		const append = (content: string, kind: LiveTailKind) => {
			messages.push(makeLiveMessage(content));
			session!.tails.push({ anchorIndex: base.length, anchorSnapshot, content, kind });
		};
		if (changed.policy) append(session.tails.some(tail => tail.kind === "goal-state") ? `${POLICY_SUPERSEDED_NOTE}\n${fresh.state}` : fresh.state, "goal-state");
		if (changed.counters) append(fresh.counters!, "goal-counters");
		// Request-only text goes last and is never retained. While superseded
		// policy blocks remain in history, say once per request which one counts.
		const superseded = session.tails.filter(tail => tail.kind === "goal-state").length > 1;
		const ephemeral = [superseded ? POLICY_RECENCY_NOTE : "", fresh.ephemeral ?? ""].filter(Boolean).join("\n");
		const stableLength = messages.length;
		if (ephemeral) messages.push(makeLiveMessage(ephemeral));
		session.baseSnapshots = snapshots;
		const previous = session.lastFresh;
		session.lastFresh = fresh.counters === undefined
			? { state: fresh.state, counters: previous?.counters, countersState: previous?.countersState, scope: fresh.scope }
			: { state: fresh.state, counters: fresh.counters, countersState: fresh.state, scope: fresh.scope };
		session.lastEphemeral = ephemeral || undefined;
		return { messages, stableLength, transientContents: [...new Set([...session.tails.map(tail => tail.content), ...(ephemeral ? [ephemeral] : [])])] };
	}

	contents(sessionKey: string): string[] | undefined {
		const session = this.sessions.get(sessionKey);
		if (!session) return undefined;
		const tails = session.tails.map(tail => tail.content);
		return session.lastEphemeral === undefined ? tails : [...tails, session.lastEphemeral];
	}

	clear(sessionKey?: string): void {
		if (sessionKey === undefined) this.sessions.clear();
		else this.sessions.delete(sessionKey);
	}
}
