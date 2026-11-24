/**
 * Audit dashboard tests (plan §19.7): the five check stages transition
 * pending → running → passed (decision → passed or failed), the auditor
 * identity is shown, percentages clamp, expanded diagnostics retain tool
 * details, the result cards render, and the normal dashboard returns after a
 * finished audit (rejection keeps the goal open; approval shows the card).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import type { AuditorProgress } from "../extensions/goal-auditor.ts";
import {
	deriveAuditResultCard,
	deriveAuditorDashboardModel,
	type AuditCheck,
} from "../extensions/widgets/auditor-dashboard-model.ts";
import { renderAuditResultCard, renderAuditorDashboard } from "../extensions/widgets/goal-dashboard-renderer.ts";
import { GoalWidgetComponent, type AuditResultView } from "../extensions/widgets/goal-widget.ts";
import { createMockTUI, createMockTheme } from "./support/tui-test-utils.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as never;

function progress(overrides: Partial<AuditorProgress> = {}): AuditorProgress {
	return {
		recentOutput: [],
		phase: "running",
		elapsedMs: 138000,
		...overrides,
	};
}

function checkState(model: ReturnType<typeof deriveAuditorDashboardModel>, id: string): AuditCheck["state"] {
	return model.checks.find((c) => c.id === id)?.state ?? "pending";
}

test("objective: pending → running → passed as the audit advances", () => {
	// No percentage yet: objective runs, everything else pending.
	const start = deriveAuditorDashboardModel(progress({ percentage: undefined, label: "Starting audit..." }));
	assert.equal(checkState(start, "objective"), "running");
	assert.equal(checkState(start, "verification"), "pending");
	assert.equal(checkState(start, "decision"), "pending");

	// At 10% objective still runs.
	const early = deriveAuditorDashboardModel(progress({ percentage: 10 }));
	assert.equal(checkState(early, "objective"), "running");

	// At 20% objective passes, verification starts.
	const mid = deriveAuditorDashboardModel(progress({ percentage: 20 }));
	assert.equal(checkState(mid, "objective"), "passed");
	assert.equal(checkState(mid, "verification"), "running");
});

test("all five stages advance in order through percentage bands (§15.2)", () => {
	const cases: Array<[number, string[]]> = [
		[0, ["running", "pending", "pending", "pending", "pending"]],
		[30, ["passed", "running", "pending", "pending", "pending"]],
		[50, ["passed", "passed", "running", "pending", "pending"]],
		[72, ["passed", "passed", "passed", "running", "pending"]],
		[90, ["passed", "passed", "passed", "passed", "running"]],
	];
	for (const [pct, expected] of cases) {
		const model = deriveAuditorDashboardModel(progress({ percentage: pct }));
		const states = model.checks.map((c) => c.state);
		assert.deepEqual(states, expected, `states at ${pct}%`);
	}
});

test("decision passes on approval and fails on disapproval/error", () => {
	const approved = deriveAuditorDashboardModel(progress({ phase: "done", percentage: 100 }), { verdict: "approved" });
	assert.deepEqual(approved.checks.map((c) => c.state), ["passed", "passed", "passed", "passed", "passed"]);
	assert.equal(approved.active, false);

	const rejected = deriveAuditorDashboardModel(progress({ phase: "done", percentage: 100 }), { verdict: "disapproved" });
	assert.equal(checkState(rejected, "decision"), "failed");
	assert.deepEqual(rejected.checks.slice(0, 4).map((c) => c.state), ["passed", "passed", "passed", "passed"], "rejection keeps prior stages passed");

	const errored = deriveAuditorDashboardModel(progress({ phase: "done", percentage: 100 }), { verdict: "error" });
	assert.equal(checkState(errored, "decision"), "failed");
});

test("auditor identity is shown in the model and the rendered header", () => {
	const model = deriveAuditorDashboardModel(progress(), { auditorLabel: "anthropic/claude-sonnet:high" });
	assert.equal(model.auditorLabel, "anthropic/claude-sonnet:high");
	const lines = renderAuditorDashboard(model, theme, 100);
	assert.match(lines[0]!, /anthropic\/claude-sonnet:high/);
	assert.match(lines[0]!, /2m18s/, "elapsed duration shown");
});

test("percentage clamps to [0, 100]", () => {
	const negative = deriveAuditorDashboardModel(progress({ percentage: -20 }));
	assert.equal(negative.percentage, 0);
	const over = deriveAuditorDashboardModel(progress({ percentage: 150 }));
	assert.equal(over.percentage, 100);
});

test("expanded diagnostics retain tool details only when requested", () => {
	const p = progress({ currentTool: "read", currentToolArgs: '{"path":"src/parser.ts"}', recentOutput: ["checking file exists..."] });
	const compact = renderAuditorDashboard(deriveAuditorDashboardModel(p), theme, 100).join("\n");
	assert.doesNotMatch(compact, /tool read/);
	assert.doesNotMatch(compact, /checking file exists/);
	const expanded = renderAuditorDashboard(deriveAuditorDashboardModel(p), theme, 100, { showToolDetails: true }).join("\n");
	assert.match(expanded, /tool read/);
	assert.match(expanded, /src\/parser\.ts/);
	assert.match(expanded, /checking file exists/);
});

test("failed audits show diagnostics automatically", () => {
	const p = progress({ phase: "done", recentOutput: ["ERROR: cannot read package.json"] });
	const model = deriveAuditorDashboardModel(p, { verdict: "error" });
	const text = renderAuditorDashboard(model, theme, 100).join("\n");
	assert.match(text, /ERROR: cannot read package.json/);
});

test("no rendered line exceeds the terminal width at 40..140 cols", () => {
	const p = progress({ percentage: 72, currentTool: "read", currentToolArgs: "x".repeat(80), recentOutput: ["y".repeat(120)] });
	for (const width of [40, 50, 60, 80, 100, 140]) {
		for (const showToolDetails of [false, true]) {
			const lines = renderAuditorDashboard(deriveAuditorDashboardModel(p), theme, width, { showToolDetails });
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line.slice(0, 50))}`);
			}
		}
		const card = renderAuditResultCard(deriveAuditResultCard("disapproved", "fix the tests".repeat(30)), theme, width);
		for (const line of card) {
			assert.ok(visibleWidth(line) <= width, `card line exceeds ${width}: ${JSON.stringify(line.slice(0, 50))}`);
		}
	}
});

test("result cards: approval, changes-required, error (§15.4)", () => {
	const approved = deriveAuditResultCard("approved", "ok");
	assert.equal(approved.label, "APPROVED");
	assert.deepEqual(approved.lines, ["Objective satisfied.", "Verification requirements satisfied.", "Required tasks and evidence accepted."]);
	const approvedText = renderAuditResultCard(approved, theme, 100).join("\n");
	assert.match(approvedText, /Audit result ─ APPROVED/);

	const rejected = deriveAuditResultCard("disapproved", [
		"Audit report:",
		"- Tests were not run after the final implementation change.",
		"- Task \"Update documentation\" has no completion evidence.",
		"<disapproved/>",
	].join("\n"));
	assert.equal(rejected.label, "CHANGES REQUIRED");
	assert.deepEqual(rejected.lines, [
		"Tests were not run after the final implementation change.",
		"Task \"Update documentation\" has no completion evidence.",
	]);
	const rejectedText = renderAuditResultCard(rejected, theme, 100).join("\n");
	assert.match(rejectedText, /✗ Tests were not run after the final implementation change[.]/);

	const errored = deriveAuditResultCard("error", "timeout");
	assert.equal(errored.label, "ERROR");
});

test("the normal dashboard returns after the audit result card clears", () => {
	const { tui } = createMockTUI();
	let auditResult: AuditResultView | null = { verdict: "disapproved", report: "- Tests were not run." };
	const component = new GoalWidgetComponent({
		tui,
		theme: createMockTheme(),
		getGoal: () => ({
			id: "g1",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			objective: "=== Goal ===\nObjective: Fix the parser",
			status: "active",
			autoContinue: true,
			usage: { activeSeconds: 10, tokensUsed: 100 },
			sisyphus: false,
			activePath: ".pi/goals/active_goal_g1.md",
		}),
		getOpenGoalCount: () => 1,
		getAuditResult: () => auditResult,
		getSettings: () => ({}),
	});
	const cardText = component.render(100).join("\n");
	assert.match(cardText, /Audit result ─ CHANGES REQUIRED/);
	assert.match(cardText, /✗ Tests were not run/);
	// The goal stays open: clearing the card restores the normal dashboard.
	auditResult = null;
	const normal = component.render(100).join("\n");
	assert.match(normal, /pi-goal-x ─ Fix the parser/);
	assert.doesNotMatch(normal, /Audit result/);
});
