import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	buildGoalAuditorPrompt,
	parseAuditorDecision,
	resolveAuditorModel,
	resolveAuditorSessionModelOptions,
	runGoalCompletionAuditor,
} from "../extensions/goal-auditor.ts";
import {
	goalSettingsPath,
	loadGoalSettings,
	loadGoalSettingsFileConfig,
	parseGoalSettings,
	saveGoalSettingsFileConfig,
} from "../extensions/goal-settings.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g1",
		objective: "Write a complete tutorial, not just a scaffold.",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

test("parseAuditorDecision requires explicit approval and lets disapproval win", () => {
	assert.deepEqual(parseAuditorDecision("Looks good\n<approved/>"), { approved: true, disapproved: false });
	assert.deepEqual(parseAuditorDecision("Nope\n<disapproved/>"), { approved: false, disapproved: true });
	assert.deepEqual(parseAuditorDecision("confused <approved/> <disapproved/>"), { approved: false, disapproved: true });
	assert.deepEqual(parseAuditorDecision("no marker"), { approved: false, disapproved: false });
});

test("resolveAuditorSessionModelOptions shares parent ModelRuntime when available", () => {
	const runtime = { id: "parent-runtime" };
	const modelRegistry = { runtime, find: () => undefined };
	const withRuntime = resolveAuditorSessionModelOptions({ modelRegistry } as any);
	assert.equal(withRuntime.modelRuntime, runtime);
	assert.equal(withRuntime.modelRegistry, modelRegistry);

	const legacyRegistry = { find: () => undefined };
	const legacy = resolveAuditorSessionModelOptions({ modelRegistry: legacyRegistry } as any);
	assert.equal(legacy.modelRuntime, undefined);
	assert.equal(legacy.modelRegistry, legacyRegistry);
});

test("runGoalCompletionAuditor passes parent modelRuntime into createSession", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const runtime = { id: "parent-runtime" };
		const modelRegistry = { runtime, find: () => undefined, getAvailable: () => [] };
		let captured: Record<string, unknown> | undefined;
		const mockSession = {
			abort: () => {},
			subscribe: () => () => {},
			prompt: async () => {},
		};

		await runGoalCompletionAuditor({
			ctx: { cwd, model: undefined, modelRegistry } as any,
			goal: goal(),
			detailedSummary: "test",
			createSession: async (opts: any) => {
				captured = opts;
				return { session: mockSession } as any;
			},
		});

		assert.equal(captured?.modelRuntime, runtime);
		assert.equal(captured?.modelRegistry, modelRegistry);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("parseGoalSettings supports provider/model and thinking_level aliases", () => {
	assert.deepEqual(parseGoalSettings({ provider: "fireworks", model: "accounts/fireworks/routers/kimi", thinking_level: "high" }), {
		provider: "fireworks",
		model: "accounts/fireworks/routers/kimi",
		thinkingLevel: "high",
	});
	assert.deepEqual(parseGoalSettings({ provider: " ", model: 123, thinkingLevel: "ludicrous" }), {});
});

test("parseGoalSettings reads disabled flag", () => {
	assert.deepEqual(parseGoalSettings({ disabled: true }), { disabled: true });
	assert.deepEqual(parseGoalSettings({ disabled: "true" }), { disabled: true });
	assert.deepEqual(parseGoalSettings({ disabled: false }), {});
	assert.deepEqual(parseGoalSettings({}), {});
});

test("saveGoalSettingsFileConfig persists UI-editable settings (auditor + task fields)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-settings-test-"));
	try {
		const saved = saveGoalSettingsFileConfig(cwd, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
		});
		assert.deepEqual(saved, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
		});
		assert.equal(goalSettingsPath(cwd), path.join(cwd, ".pi", "pi-goal-x-settings.json"));
		assert.deepEqual(loadGoalSettingsFileConfig(cwd), saved);
		assert.match(fs.readFileSync(goalSettingsPath(cwd), "utf8"), /"thinking_level": "high"/);

		// Save with disabled flag
		const saved2 = saveGoalSettingsFileConfig(cwd, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
			disabled: true,
		});
		assert.equal(saved2.disabled, true);
		assert.match(fs.readFileSync(goalSettingsPath(cwd), "utf8"), /"disabled": true/);
		assert.deepEqual(loadGoalSettingsFileConfig(cwd), saved2);

		// autoSelectSingleGoal: persisted only when true (default is false)
		const saved3 = saveGoalSettingsFileConfig(cwd, { autoSelectSingleGoal: true });
		assert.deepEqual(saved3, { autoSelectSingleGoal: true });
		assert.match(fs.readFileSync(goalSettingsPath(cwd), "utf8"), /"autoSelectSingleGoal": true/);
		assert.deepEqual(loadGoalSettingsFileConfig(cwd), saved3);
		const saved4 = saveGoalSettingsFileConfig(cwd, { autoSelectSingleGoal: false });
		assert.equal(saved4.autoSelectSingleGoal, undefined);
		assert.doesNotMatch(fs.readFileSync(goalSettingsPath(cwd), "utf8"), /autoSelectSingleGoal/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadGoalSettings does not read old env vars", () => {
	// Old env vars are ignored; only PI_GOAL_DISABLE_TASKS/CONTRACTS work
	assert.deepEqual(loadGoalSettings("/tmp", { PI_GOAL_AUDITOR_PROVIDER: "fireworks" as string }).provider, undefined);
	// PI_GOAL_SETTINGS_FILE env var can point to an alternative path
});

test("buildGoalAuditorPrompt demands semantic approval markers", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		detailedSummary: "Goal: tutorial",
	});
	assert.ok(prompt.includes("independent completion auditor"));
	assert.ok(prompt.includes("scaffold-only") || prompt.includes("alpha scaffold") || prompt.includes("generated template"));
	assert.ok(prompt.includes("<approved/>"));
	assert.ok(prompt.includes("<disapproved/>"));
	assert.ok(prompt.includes("<executor_claim>"), "untrusted executor claim section present");
	assert.ok(prompt.includes("UNTRUSTED"), "claim is marked untrusted");
	assert.ok(prompt.includes("(no claim provided)"), "absent claim renders explicitly");
	assert.ok(!prompt.includes("<test_evidence>"), "should not contain deprecated <test_evidence>");
	assert.ok(prompt.includes("4. Explain missing or weak evidence"));
	assert.ok(prompt.includes("5. End with exactly <approved/>"));
});

test("buildGoalAuditorPrompt renders a completion summary as an untrusted claim", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		detailedSummary: "Goal: test",
		completionSummary: "Ran npm test (0 failures) and everything is green.",
	});
	assert.ok(prompt.includes("Ran npm test (0 failures)"), "claim text reaches the auditor");
	assert.ok(prompt.includes("claim, never evidence"), "claim is not treated as evidence");
	assert.ok(prompt.includes("cannot make an otherwise incomplete goal complete"), "claim cannot approve");
	assert.ok(prompt.includes("cross-check it against real artifacts"), "auditor cross-checks the claim");
});

test("buildGoalAuditorPrompt renders verification contract when goal has one", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal({ verificationContract: "Run npm test (0 failures), grep for remaining references, re-read requirements" }),
		detailedSummary: "Goal: test",
	});
	assert.ok(prompt.includes("<verification_contract>"));
	assert.ok(prompt.includes("Run npm test (0 failures)"));
	assert.ok(prompt.includes("grep for remaining references"));
	assert.ok(prompt.includes("</verification_contract>"));
	// The contract checklist step appears when verificationContract is present
	assert.ok(prompt.includes("3. Verify that the executor has satisfied every item in the <verification_contract>"));
});

test("buildGoalAuditorPrompt omits verification sections when absent", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		detailedSummary: "Goal: test",
	});
	assert.ok(!prompt.includes("<verification_summary>"), "must never contain a verification-summary section (paperwork removed)");
	assert.ok(!prompt.includes("<verification_contract>"), "should not contain <verification_contract> when goal has none");
	// Checklist should skip steps that depend on absent sections
	assert.ok(prompt.includes("4. Explain missing or weak evidence"));
	assert.ok(prompt.includes("5. End with exactly <approved/>"));
	assert.ok(!prompt.includes("3. Verify that the executor has satisfied"), "contract step should be omitted without verificationContract");
});

test("runGoalCompletionAuditor returns aborted error when signal is already aborted (pre-flight)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		ctrl.abort(); // Already aborted before call

		let abortCalledOnSession = false;
		const mockSession = {
			abort: () => { abortCalledOnSession = true; },
			subscribe: () => () => {},
			prompt: () => { throw new Error("prompt should not be called"); },
		};

		const result = await runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		assert.equal(result.error, "Auditor aborted.");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.equal(result.output, "");
		// The signal listener for the already-aborted signal should have been
		// cleaned up in the inner finally before session.abort() could fire.
		assert.equal(abortCalledOnSession, false, "session.abort() should not be called for pre-flight abort");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("runGoalCompletionAuditor aborts running prompt when signal fires (abort during prompt)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		let abortCalledOnSession = false;
		let promptReject: (e: Error) => void;

		const mockSession = {
			abort: () => {
				abortCalledOnSession = true;
				promptReject?.(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
			},
			subscribe: () => () => {},
			prompt: () => new Promise<void>((_, reject) => { promptReject = reject; }),
		};

		const resultPromise = runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		// Yield to let the async setup run (createSession resolves, prompt is entered)
		await new Promise((r) => setTimeout(r, 0));

		// At this point prompt() should be "running" — trigger the abort
		ctrl.abort();

		const result = await resultPromise;

		assert.equal(result.error, "Auditor aborted.");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.ok(abortCalledOnSession, "session.abort() must have been called via the signal listener");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * Validate that when session.abort() DOES NOT throw (the real agent behavior),
 * the post-prompt signal check catches the abort and returns the expected
 * "Auditor aborted." error instead of treating it as a normal (empty) result.
 */
test("runGoalCompletionAuditor detects abort when session.prompt returns normally (no throw)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		let abortCalledOnSession = false;
		let promptResolve: () => void;

		const mockSession = {
			abort: () => {
				abortCalledOnSession = true;
				// Real session.abort() calls agent.abort() then await waitForIdle().
				// The agent loop returns normally (no throw) with whatever output
				// was captured before the abort. Simulate that by resolving prompt.
				promptResolve?.();
			},
			subscribe: () => () => {},
			prompt: () => new Promise<void>((resolve) => { promptResolve = resolve; }),
		};

		const resultPromise = runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		// Yield to let createSession resolve
		await new Promise((r) => setTimeout(r, 0));

		// Abort while prompt is still running — this triggers abortSession listener
		// which calls session.abort(), which resolves the prompt.
		ctrl.abort();

		const result = await resultPromise;

		assert.equal(result.error, "Auditor aborted.");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.ok(abortCalledOnSession, "session.abort() must have been called via the signal listener");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * Verify that the abort signal listener is properly cleaned up after a normal
 * (non-aborted) audit run resolves, preventing memory leaks.
 */
test("runGoalCompletionAuditor cleans up abort listener on normal completion", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		let abortCalledOnSession = false;

		const mockSession = {
			abort: () => { abortCalledOnSession = true; },
			subscribe: () => () => {},
			prompt: async () => {
				// Simulate a normal prompt that completes without abort
			},
		};

		const result = await runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		// Normal completion — no abort occurred, no approval/disapproval markers
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, false); // Empty output has no disapproval marker
		assert.equal(result.error, undefined); // No error
		assert.equal(abortCalledOnSession, false, "session.abort() should not have been called");

		// Also verify the signal listener was cleaned up: triggering the signal after
		// completion should NOT call session.abort()
		ctrl.abort();
		assert.equal(abortCalledOnSession, false, "session.abort() should not fire after cleanup");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("resolveAuditorModel refuses provider-only settings instead of choosing the first available model", () => {
	const result = resolveAuditorModel({
		modelRegistry: {
			getAvailable: () => [{ provider: "deepseek", id: "first" }],
			find: () => undefined,
		},
		model: undefined,
	} as never, { provider: "deepseek" } as never);
	assert.equal(result.model, undefined);
	assert.match(result.error ?? "", /Provider-only auditor configuration is refused/);
});

test("resolveAuditorModel resolves explicit provider/model and falls back to the session model when unset", () => {
	const model = { provider: "alpha", id: "fast" };
	const explicit = resolveAuditorModel({
		modelRegistry: {
			getAvailable: () => [model],
			find: (p: string, m: string) => (p === "alpha" && m === "fast" ? model : undefined),
		},
		model: undefined,
	} as never, { provider: "alpha", model: "fast" } as never);
	assert.equal(explicit.model, model);

	const session = { provider: "alpha", id: "fast" };
	const unset = resolveAuditorModel({
		modelRegistry: { getAvailable: () => [model], find: () => undefined },
		model: session,
	} as never, {} as never);
	assert.equal(unset.model, session);
});
