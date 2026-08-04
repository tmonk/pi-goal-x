/**
 * Auditor model/thinking selector helpers (ll01 cb6760b pattern).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	buildAuditorModelChoices,
	configuredAuditorModelKey,
	filterAuditorModelChoices,
	parseManualAuditorModel,
	thinkingLevelChoices,
} from "../extensions/auditor-selector.ts";

test("auditor selector offers current/default, authenticated models with ✓ marker, and manual fallback", () => {
	const choices = buildAuditorModelChoices(
		[
			{ provider: "zeta", id: "slow", name: "Slow" },
			{ provider: "alpha", id: "fast" },
		],
		"alpha/fast",
		"zeta/slow",
	);
	assert.equal(choices[0]!.kind, "default");
	assert.ok(choices[0]!.label.includes("Current session / default"));
	assert.ok(choices[0]!.label.includes("(zeta/slow)"), "default entry shows the session model");

	const modelChoices = choices.filter((c) => c.kind === "model");
	assert.equal(modelChoices.length, 2, "both authenticated models listed");
	assert.ok(
		modelChoices.some((c) => c.kind === "model" && c.label.startsWith("✓ ") && c.label.includes("alpha/fast")),
		"exact configured model carries the ✓ marker",
	);
	assert.ok(modelChoices.some((c) => c.kind === "model" && c.label.includes("zeta/slow — Slow")), "label includes the display name");

	assert.ok(choices.some((c) => c.kind === "manual"), "manual entry present");
});

test("auditor selector: no ✓ when nothing is configured, default shows (system default)", () => {
	const choices = buildAuditorModelChoices([{ provider: "alpha", id: "fast" }], undefined, undefined);
	assert.ok(choices[0]!.label.includes("(system default)"));
	assert.ok(!choices[0]!.label.startsWith("✓ "), "no ✓ on default when unset");
	assert.ok(choices[1]!.kind === "model" && !choices[1]!.label.startsWith("✓ "), "no ✓ on models when unset");
});

test("filterAuditorModelChoices narrows by provider/id/name and keeps default+manual", () => {
	const choices = buildAuditorModelChoices(
		[
			{ provider: "zeta", id: "slow" },
			{ provider: "alpha", id: "fast" },
		],
		undefined,
		undefined,
	);
	const filtered = filterAuditorModelChoices(choices, "zeta");
	assert.equal(filtered.filter((c) => c.kind === "model").length, 1);
	assert.ok(filtered.some((c) => c.kind === "default") && filtered.some((c) => c.kind === "manual"));
	assert.equal(filterAuditorModelChoices(choices, "  ").length, choices.length, "blank filter keeps everything");
});

test("parseManualAuditorModel requires provider/model format", () => {
	assert.deepEqual(parseManualAuditorModel(" fireworks/accounts/model "), { provider: "fireworks", model: "accounts/model" });
	assert.ok("error" in parseManualAuditorModel("model-without-provider"));
	assert.ok("error" in parseManualAuditorModel("/leading"));
	assert.ok("error" in parseManualAuditorModel("trailing/"));
});

test("configuredAuditorModelKey joins provider/model only when both set", () => {
	assert.equal(configuredAuditorModelKey({ provider: "a", model: "b" }), "a/b");
	assert.equal(configuredAuditorModelKey({ provider: "a" }), undefined);
	assert.equal(configuredAuditorModelKey({}), undefined);
});

test("thinkingLevelChoices marks the current level and offers (default)", () => {
	assert.deepEqual(thinkingLevelChoices("high")[5], "✓ high");
	assert.equal(thinkingLevelChoices("high")[0], "  (default)");
	assert.equal(thinkingLevelChoices(undefined)[0], "  (default)");
	assert.equal(thinkingLevelChoices(undefined).length, 7, "default + six levels");
});
