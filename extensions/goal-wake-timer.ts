/** The longest delay setTimeout accepts; anything longer fires immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * One re-armable, unref'd timer. Scheduling intent lives in the goal file, so
 * this only arranges a moment to look at it again.
 */
export class WakeTimer {
	private handle: ReturnType<typeof setTimeout> | undefined;

	cancel(): void {
		if (this.handle !== undefined) clearTimeout(this.handle);
		this.handle = undefined;
	}

	/** Replace any pending timer with one that calls `fn` after `delay` ms. */
	arm(delay: number, fn: () => void): void {
		this.cancel();
		this.handle = setTimeout(() => { this.handle = undefined; fn(); }, Math.min(MAX_TIMEOUT_MS, Math.max(0, delay)));
		this.handle.unref?.();
	}
}
