import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import piGoalExtension from "../extensions/goal.ts";

const tools: ToolDefinition[] = [];

piGoalExtension({
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
};

function renderCall(name: string, args: Record<string, unknown>): string {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `Tool ${name} should be registered`);
	assert.ok(tool.renderCall, `Tool ${name} should define renderCall`);
	return tool.renderCall(args as any, theme as any, {} as any).render(1_000).map((line) => line.trimEnd()).join("\n");
}

describe("lifecycle tool call rendering", () => {
	it("shows full pause and abort reasons even when they exceed 80 characters", () => {
		const reason = "The agent cannot continue because the required deployment credential is unavailable in the current environment.";
		assert.ok(reason.length > 80);

		assert.equal(renderCall("pause_goal", { reason }), `pause_goal ${reason}`);
		assert.equal(renderCall("abort_goal", { reason }), `abort_goal ${reason}`);
	});

	it("keeps potentially large proposal previews truncated", () => {
		const longText = "A deliberately long preview value ".repeat(10).trim();
		assert.ok(longText.length > 80);

		for (const [name, args] of [
			["propose_goal_draft", { objective: longText, sisyphus: false }],
			["propose_goal_tweak", { changeSummary: longText }],
			["propose_task_list", { changeSummary: longText, tasks: [] }],
		] as const) {
			const rendered = renderCall(name, args);
			assert.ok(rendered.endsWith("..."), `${name} should retain its compact preview`);
			assert.equal(rendered.includes(longText), false, `${name} should not render the full preview`);
		}
	});
});
