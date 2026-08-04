/**
 * Goal tool-call heading rendering regression tests.
 *
 * Port of PR #11's tests/goal-lifecycle-rendering.test.ts to the simplified
 * five-tool surface, per the user decision that full behavior is ported and
 * NO compact previews remain anywhere: every goal tool-call heading renders
 * its complete content, wrapped to terminal width by pi's Text component,
 * with no truncation.
 *
 * Covered:
 * - update_goal shows the COMPLETE agent-provided reason for status=paused
 *   and status=blocked (not just "update_goal paused"), even beyond 80 chars.
 * - update_goal shows the full completion summary for status=complete.
 * - set_goal_tasks renders an untruncated change_summary (was 80-char
 *   truncateText; PR #11's "compact previews stay" carve-out is dropped).
 * - propose_goal_draft renders the full objective.
 * - Long content wraps to multiple lines at narrow terminal widths and never
 *   ends in the truncation marker "...".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";

const tools: ToolDefinition[] = [];

goalExtension({
	registerTool: (tool: ToolDefinition) => tools.push(tool),
	registerCommand: () => {},
	on: () => {},
	appendEntry: () => {},
	registerMessageRenderer: () => {},
	sendMessage: () => {},
	getActiveTools: () => [],
	setActiveTools: () => {},
	hasUI: false,
} as any);

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: () => "",
	dim: (text: string) => text,
};

function renderCall(name: string, args: Record<string, unknown>, width = 1_000): string {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `Tool ${name} should be registered`);
	assert.ok(tool.renderCall, `Tool ${name} should define renderCall`);
	return tool.renderCall(args as any, theme as any, {} as any).render(width).map((line) => line.trimEnd()).join("\n");
}

describe("goal tool-call heading rendering", () => {
	it("update_goal shows the full paused reason even beyond 80 characters", () => {
		const reason = "The agent cannot continue because the required deployment credential is unavailable in the current environment.";
		assert.ok(reason.length > 80, "reason must exceed 80 characters");
		assert.equal(renderCall("update_goal", { status: "paused", reason }), `update_goal paused ${reason}`);
	});

	it("update_goal shows the full blocked reason and does not degrade to status-only", () => {
		const reason = "The same search endpoint returned an error across three consecutive goal turns and the fix requires credentials only the user can provide.";
		assert.ok(reason.length > 80);
		const rendered = renderCall("update_goal", { status: "blocked", reason });
		assert.ok(rendered.startsWith("update_goal blocked"), "status is shown");
		assert.ok(rendered.includes(reason), "complete reason is present");
		assert.equal(rendered.endsWith("..."), false, "never truncated");
	});

	it("update_goal shows the full completion summary for status=complete", () => {
		const summary = "Alt-screen dialogs preserve scrollback; every goal tool-call heading renders its complete content wrapped to the terminal width with no truncation anywhere.";
		assert.ok(summary.length > 80);
		const rendered = renderCall("update_goal", { status: "complete", completion_summary: summary });
		assert.ok(rendered.startsWith("update_goal complete"));
		assert.ok(rendered.includes(summary), "full completion summary is present");
		assert.equal(rendered.endsWith("..."), false, "never truncated");
	});

	it("set_goal_tasks renders the full change summary (no compact preview)", () => {
		const longSummary = "A deliberately long change summary for the structural task-tree replacement ".repeat(4).trim();
		assert.ok(longSummary.length > 80);
		const rendered = renderCall("set_goal_tasks", { change_summary: longSummary, tasks: [] });
		assert.ok(rendered.startsWith("set_goal_tasks "));
		assert.ok(rendered.includes(longSummary), "full summary is present");
		assert.equal(rendered.endsWith("..."), false, "never truncated");
	});

	it("set_goal_tasks falls back to a task count when no summary is given", () => {
		assert.equal(renderCall("set_goal_tasks", { tasks: [{ id: "a" }, { id: "b" }] }), "set_goal_tasks 2 tasks");
	});

	it("propose_goal_draft renders the full objective", () => {
		const longObjective = "Build a thing that does a great many things for a great many users ".repeat(5).trim();
		assert.ok(longObjective.length > 80);
		const rendered = renderCall("propose_goal_draft", { objective: longObjective, sisyphus: false });
		assert.ok(rendered.startsWith("propose_goal_draft "));
		assert.ok(rendered.includes(longObjective), "full objective is present");
		assert.equal(rendered.endsWith("..."), false, "never truncated");
	});

	it("long headings wrap to multiple lines at narrow widths and keep full content", () => {
		const reason = "The agent cannot continue because the required deployment credential is unavailable in the current environment.";
		const width = 40;
		const rendered = renderCall("update_goal", { status: "paused", reason }, width);
		const lines = rendered.split("\n");
		assert.ok(lines.length > 1, `heading wraps at width ${width}`);
		assert.ok(lines.every((line) => line.length <= width), "no line exceeds the terminal width");
		// words wrap across lines, so normalize line breaks to assert full content
		assert.ok(rendered.replace(/\n/g, " ").includes(reason), "full reason survives wrapping");
		assert.equal(rendered.endsWith("..."), false, "never truncated");
	});
});
