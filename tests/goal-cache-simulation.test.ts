import test from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, run, productionStrategy, currentStrategy } from "../experiments/prompt-cache/simulate.ts";

// Request construction only: this checks how much of each request extends the
// one before it. It does not measure live provider hit rates.
for (const scenario of SCENARIOS) test(`simulated ${scenario.name} session keeps its prompt prefix`, () => {
	const result = run(productionStrategy(), scenario);
	assert.equal(result.bigBreaks, 0, "no request loses most of the previous prefix");
	assert.ok(result.cacheShare > 0.98, `cache share ${result.cacheShare}`);
	// Unchanged goal text must never cost more than the older layout.
	assert.ok(result.cost <= run(currentStrategy(), scenario).cost * 1.01);
});
