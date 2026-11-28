import { hash } from "node:crypto";
import type { LiveTailRetention, RetainedState } from "./goal-live-retention.ts";

/**
 * Saves the retained goal blocks with the session, so that a restart or /resume
 * sends the same prefix as the request before it. The blocks are request-only and
 * never part of the conversation, so without this a new process starts with none
 * and the cache (a local server's, or a provider's still-warm one) is missed once.
 *
 * Only changes are saved, as small custom entries that never reach the model. Each
 * new block records a hash of the history before it. On restore a block is kept only
 * if that history is unchanged, so a compaction, a branch or an edit just starts clean.
 */
export const LIVE_RETENTION_ENTRY = "pi-goal-live-tails";

type Saved = RetainedState["tails"][number];
type Fresh = RetainedState["lastFresh"];

type Op =
	| { v: 1; model: string; op: "reset" }
	| { v: 1; model: string; op: "tail"; prefixHash: string } & Saved
	| { v: 1; model: string; op: "fresh"; lastFresh: Fresh; interim: boolean };

const messageHash = (message: unknown): string => {
	try {
		return hash("sha256", JSON.stringify(message) ?? "", "base64");
	} catch {
		return "";
	}
};

/** Hashes of the history before each position: the item at n covers messages 0..n-1. */
function prefixHashes(base: readonly unknown[], upTo: number): string[] {
	const out = [hash("sha256", "", "base64")];
	for (let i = 0; i < upTo; i++) out.push(hash("sha256", `${out[i]}${messageHash(base[i])}`, "base64"));
	return out;
}

const sameTail = (a: Saved, b: Saved): boolean => a.anchorIndex === b.anchorIndex && a.content === b.content && a.kind === b.kind;

/** Save what changed since the last time. `append` writes one session entry. */
export function saveLiveTails(retention: LiveTailRetention, key: string, model: string, base: readonly unknown[], append: (type: string, data: unknown) => void): void {
	const now = retention.exportState(key);
	const before = retention.saved.get(key);
	const known: RetainedState | undefined = before ? JSON.parse(before) : undefined;
	const ops: Op[] = [];
	if (!now) {
		if (known) ops.push({ v: 1, model, op: "reset" });
		retention.saved.delete(key);
	} else {
		let common = 0;
		if (known) while (common < known.tails.length && common < now.tails.length && sameTail(known.tails[common]!, now.tails[common]!)) common++;
		if (known && common < known.tails.length) { ops.push({ v: 1, model, op: "reset" }); common = 0; }
		const fresh = now.tails.slice(common);
		if (fresh.length) {
			const hashes = prefixHashes(base, Math.max(...fresh.map(tail => tail.anchorIndex)));
			for (const tail of fresh) ops.push({ v: 1, model, op: "tail", prefixHash: hashes[tail.anchorIndex] ?? "", ...tail });
		}
		const freshState = JSON.stringify([now.lastFresh, now.interim]);
		if (ops.length || freshState !== JSON.stringify([known?.lastFresh, known?.interim])) ops.push({ v: 1, model, op: "fresh", lastFresh: now.lastFresh, interim: now.interim });
		retention.saved.set(key, JSON.stringify(now));
	}
	for (const op of ops) append(LIVE_RETENTION_ENTRY, op);
}

/** Rebuild the saved blocks from the session's entries, if the history still matches. */
export function restoreLiveTails(retention: LiveTailRetention, key: string, model: string, entries: readonly unknown[], base: readonly unknown[]): void {
	const ops = entries.flatMap(entry => {
		const record = entry as { type?: string; customType?: string; data?: Op } | null;
		const data = record?.type === "custom" && record.customType === LIVE_RETENTION_ENTRY ? record.data : undefined;
		return data && data.v === 1 && data.model === model ? [data] : [];
	});
	if (!ops.length) return;
	let tails: Array<Saved & { prefixHash: string }> = [];
	let lastFresh: Fresh | undefined;
	let interim = false;
	for (const op of ops) {
		if (op.op === "reset") { tails = []; lastFresh = undefined; interim = false; }
		else if (op.op === "fresh") { lastFresh = op.lastFresh; interim = op.interim; }
		else { const { v: _v, model: _model, op: _op, ...tail } = op; tails.push(tail); }
	}
	// Only the blocks still standing have to match the history.
	if (!lastFresh || !tails.length || tails.some(tail => tail.anchorIndex > base.length)) return;
	const hashes = prefixHashes(base, Math.max(...tails.map(tail => tail.anchorIndex)));
	if (tails.some(tail => hashes[tail.anchorIndex] !== tail.prefixHash)) return;
	const state: RetainedState = { tails: tails.map(({ prefixHash: _hash, ...tail }) => tail), lastFresh, interim };
	retention.adopt(key, state, base);
	retention.saved.set(key, JSON.stringify(state));
}
