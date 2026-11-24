/**
 * Composed-request size breakdown (PR D).
 *
 * Measures every component of the model-facing request — including the tool
 * schemas and historical checkpoint payload that B4 never saw.
 */

import { countSemanticOccurrences, currentTaskNeedle } from "./semantic-invariants.mjs";

/**
 * Serialize one captured request to the exact text whose size we report.
 */
export function serializeRequest(captured) {
	const system = `${captured.baseSystem}${captured.extensionSystem ?? ""}`;
	// Retain tool calls, arguments, roles, and results as well as text blocks.
	// Provider-specific framing/tokenization is cross-checked separately.
	const messages = JSON.stringify(captured.messages ?? []);
	const tools = (captured.tools ?? [])
		.map((t) => `${t.name}\n${t.description}\n${JSON.stringify(t.schema ?? {})}`)
		.join("\n");
	const hostTools = (captured.hostTools ?? []).map(t => `${t.name}\n${t.description}\n${JSON.stringify(t.schema ?? {})}`).join("\n");
 return { system, messages, tools, hostTools, total: `${system}\n${messages}\n${tools}\n${hostTools}` };
}

/**
 * Compute ContextSizeBreakdown for one captured request.
 */
export function measureContext(captured) {
	const goal = captured.goal;
	const serialized = serializeRequest(captured);

	let checkpointChars = 0;
	let historicalCheckpointChars = 0;
	const messageChars = serialized.messages.length;
	for (const message of captured.messages ?? []) {
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.map((p) => p.text ?? "").join("")
				: "";
		if (message.role === "custom" && message.customType === "pi-goal-event") {
			checkpointChars += text.length;
			// Historical = any pi-goal-event beyond the LAST one in the list.
		}
	}
	// Historical checkpoints: every event message except the last one.
	const eventIndexes = [];
	(captured.messages ?? []).forEach((m, i) => {
		if (m.role === "custom" && m.customType === "pi-goal-event") eventIndexes.push(i);
	});
	for (let k = 0; k < eventIndexes.length - 1; k += 1) {
		const m = captured.messages[eventIndexes[k]];
		historicalCheckpointChars += typeof m.content === "string" ? m.content.length : 0;
	}
	void checkpointChars;

	const baseSystemChars = captured.baseSystem.length;
	const extensionSystemChars = (captured.extensionSystem ?? "").length;
	// Current goal state is a request-only message at the tail.
	const goalStateChars = (captured.messages ?? []).filter(m => m.customType === "pi-goal-live-context").reduce((sum, m) => sum + m.content.length, 0);
	const toolSchemaChars = serialized.tools.length;

	const childRequestChars = (captured.childRequests ?? []).reduce((sum, request) => sum + request.system.length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length, 0);
 const extensionMessageChars = (captured.messages ?? []).filter(message =>
  (message.role === "toolResult" && /^(get_goal|create_goal|update_goal|set_goal_tasks|update_goal_task|goal_questionnaire|propose_goal_draft)$/.test(message.toolName ?? "")) ||
  (message.role === "custom" && message.customType?.startsWith("pi-goal"))
 ).reduce((sum, message) => sum + JSON.stringify(message).length, 0);
 return {
  sdkGuidanceChars: captured.sdkGuidanceChars ?? 0,
  hostToolSchemaChars: serialized.hostTools.length,
  childRequestChars,
  extensionMessageChars,
  extensionAttributableChars: extensionSystemChars + toolSchemaChars + (captured.sdkGuidanceChars ?? 0) + extensionMessageChars + childRequestChars,
		baseSystemChars,
		extensionSystemChars,
		goalStateChars,
		checkpointChars: checkpointTotal(captured),
		historicalCheckpointChars,
		toolSchemaChars,
		messageChars,
		totalSerializedChars: serialized.total.length,
		estimatedTokens: Math.ceil(serialized.total.length / 4),
	};
}

function checkpointTotal(captured) {
	let sum = 0;
	for (const m of captured.messages ?? []) {
		if (m.role === "custom" && m.customType === "pi-goal-event" && typeof m.content === "string") sum += m.content.length;
	}
	return sum;
}

/** Semantic counts for one captured request. Pass `goal` for exact needles. */
export function semanticCounts(captured) {
	const serialized = serializeRequest(captured);
	return countSemanticOccurrences(serialized.total, {
		objective: captured.goal?.objective,
		verificationContract: captured.goal?.verificationContract,
		currentTaskLine: currentTaskNeedle(captured.goal),
	});
}
