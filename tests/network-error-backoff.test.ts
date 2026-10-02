import assert from "node:assert/strict";
import test from "node:test";

import {
	NETWORK_ERROR_BACKOFF_DELAYS_MS,
	networkErrorBackoffPlan,
} from "../extensions/network-error-backoff.ts";
import {
	hasNetworkErrorAssistantMessage,
	isNetworkErrorAssistantMessage,
} from "../extensions/goal-format.ts";

test("network-error backoff escalates and plateaus; default policy is unbounded", () => {
	assert.deepEqual(NETWORK_ERROR_BACKOFF_DELAYS_MS, [5_000, 10_000, 20_000, 40_000, 80_000]);
	assert.deepEqual(networkErrorBackoffPlan(1), { attempt: 1, maxAttempts: 0, delayMs: 5_000 });
	assert.deepEqual(networkErrorBackoffPlan(5), { attempt: 5, maxAttempts: 0, delayMs: 80_000 });
	assert.equal(networkErrorBackoffPlan(0), undefined);
	// Unbounded default: the ladder plateaus at the max delay forever.
	assert.deepEqual(networkErrorBackoffPlan(6), { attempt: 6, maxAttempts: 0, delayMs: 80_000 });
	assert.deepEqual(networkErrorBackoffPlan(50), { attempt: 50, maxAttempts: 0, delayMs: 80_000 });
});

test("network-error backoff honors a configured bounded cap and custom plateau", () => {
	const bounded = { maxAttempts: 3, maxDelayMs: 15_000 };
	assert.deepEqual(networkErrorBackoffPlan(1, bounded), { attempt: 1, maxAttempts: 3, delayMs: 5_000 });
	assert.deepEqual(networkErrorBackoffPlan(2, bounded), { attempt: 2, maxAttempts: 3, delayMs: 10_000 });
	assert.deepEqual(networkErrorBackoffPlan(3, bounded), { attempt: 3, maxAttempts: 3, delayMs: 15_000 }, "ladder capped by maxDelayMs");
	assert.equal(networkErrorBackoffPlan(4, bounded), undefined, "bounded cap exhausts");
	assert.deepEqual(
		networkErrorBackoffPlan(9, { maxAttempts: 0, maxDelayMs: 1_000 }),
		{ attempt: 9, maxAttempts: 0, delayMs: 1_000 },
		"custom plateau applies indefinitely when unbounded",
	);
});

test("network-error detection accepts provider error text and raw finish reason only", () => {
	assert.equal(
		isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: network_error" }),
		true,
	);
	assert.equal(
		isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "error", rawStopReason: "network-error" }),
		true,
	);
	assert.equal(
		isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" }),
		false,
	);
	assert.equal(
		isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "stop", errorMessage: "network_error" }),
		false,
	);
	assert.equal(
		isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: error" }),
		true,
	);
	assert.equal(
		isNetworkErrorAssistantMessage({ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason:  error" }),
		true,
	);
	assert.equal(
		hasNetworkErrorAssistantMessage([
			{ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: error" },
			{ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" },
		]),
		true,
	);
});
