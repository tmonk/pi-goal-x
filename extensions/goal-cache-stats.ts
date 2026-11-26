import { asRecord } from "./goal-record.ts";
import { t } from "./i18n/index.ts";

/** A prompt shorter than this is too small for a provider to cache, so it says nothing about hits. */
const MIN_PROMPT_TOKENS = 2000;
const GOOD_RATIO = 0.5;
const BAD_RATIO = 0.05;

function tokens(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Reads what the provider says it cached, from the usage record on each
 * assistant message. The request tests only prove how a request is built;
 * this shows what actually happened, and warns when hits fall away.
 */
export class CacheStats {
	private requests = 0;
	private prompt = 0;
	private read = 0;
	private lastRatio: number | undefined;
	private hadGoodHit = false;
	private badStreak = 0;
	private warned = false;
	private key: string | undefined;

	/**
	 * Returns a one-time warning when hits drop to nearly zero twice in a row after working well.
	 * `key` names the goal. A new goal starts a new prompt, so the first misses after a change are expected.
	 */
	record(usage: unknown, key?: string): string | undefined {
		const raw = asRecord(usage);
		if (!raw) return undefined;
		if (key !== this.key) {
			this.key = key;
			this.hadGoodHit = false;
			this.badStreak = 0;
			this.warned = false;
		}
		const read = tokens(raw.cacheRead);
		const prompt = tokens(raw.input) + read + tokens(raw.cacheWrite);
		if (prompt < MIN_PROMPT_TOKENS) return undefined;
		this.requests++;
		this.prompt += prompt;
		this.read += read;
		const ratio = read / prompt;
		this.lastRatio = ratio;
		if (ratio >= GOOD_RATIO) {
			this.hadGoodHit = true;
			this.badStreak = 0;
			this.warned = false;
			return undefined;
		}
		if (!this.hadGoodHit || ratio >= BAD_RATIO) { this.badStreak = 0; return undefined; }
		this.badStreak++;
		if (this.badStreak < 2 || this.warned) return undefined;
		this.warned = true;
		return t("Prompt cache hits fell to {percent}% on two requests in a row, after working well. Something early in the prompt changed: another extension, a model or provider switch, compaction, or the cache expired.", { percent: Math.round(ratio * 100) });
	}

	/** One line for /goal-status verbose, or nothing when no request was large enough to judge. */
	line(): string | undefined {
		if (this.requests === 0) return undefined;
		const overall = Math.round((this.read / this.prompt) * 100);
		const last = Math.round((this.lastRatio ?? 0) * 100);
		return t("Prompt cache this session: {overall}% of input read from cache over {n} requests (last request {last}%)", { overall, n: this.requests, last });
	}
}
