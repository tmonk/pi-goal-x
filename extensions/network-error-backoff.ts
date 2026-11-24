/**
 * Goal-level recovery after Pi has exhausted its provider retries.
 *
 * Pi owns the immediate request retries. These longer delays are deliberately
 * slow and only apply to transient provider failures, so an unavailable
 * provider never becomes a rapid auto-continue loop.
 *
 * Default policy is UNBOUNDED: recovery keeps retrying forever on an
 * escalating delay ladder that plateaus at `maxDelayMs`. A bounded cap can
 * be configured via layered settings (`networkRecovery.maxAttempts`, where
 * 0/unset means unbounded).
 */

export const NETWORK_ERROR_BACKOFF_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 80_000] as const;

/** Recovery policy: maxAttempts 0 = unbounded (default); delays plateau at maxDelayMs. */
export interface NetworkErrorRecoveryPolicy {
	maxAttempts: number;
	maxDelayMs: number;
}

const DEFAULT_NETWORK_ERROR_RECOVERY_POLICY: NetworkErrorRecoveryPolicy = {
	maxAttempts: 0,
	maxDelayMs: NETWORK_ERROR_BACKOFF_DELAYS_MS[NETWORK_ERROR_BACKOFF_DELAYS_MS.length - 1]!,
};

export interface NetworkErrorBackoffPlan {
	attempt: number;
	/** 0 = unbounded. */
	maxAttempts: number;
	delayMs: number;
}

function rawLadderDelay(attempt: number): number {
	const last = NETWORK_ERROR_BACKOFF_DELAYS_MS.length - 1;
	return NETWORK_ERROR_BACKOFF_DELAYS_MS[Math.min(attempt - 1, last)]!;
}

/**
 * Return the recovery plan for a one-based attempt under the given policy,
 * or undefined once a configured bounded cap is exhausted. With the default
 * unbounded policy this never returns undefined.
 */
export function networkErrorBackoffPlan(
	attempt: number,
	policy: NetworkErrorRecoveryPolicy = DEFAULT_NETWORK_ERROR_RECOVERY_POLICY,
): NetworkErrorBackoffPlan | undefined {
	if (!Number.isInteger(attempt) || attempt < 1) return undefined;
	if (policy.maxAttempts > 0 && attempt > policy.maxAttempts) return undefined;
	return {
		attempt,
		maxAttempts: policy.maxAttempts,
		delayMs: Math.min(rawLadderDelay(attempt), policy.maxDelayMs),
	};
}
