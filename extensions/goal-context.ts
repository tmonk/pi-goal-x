import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Filter after Pi restores system and tool state, including on the first request. */
export function registerGoalContext(
	pi: Pick<ExtensionAPI, "on">,
	transform: (messages: unknown[], ctx: ExtensionContext) => unknown[] | null,
): void {
	pi.on("context_with_system", (event, ctx) => {
		const messages = transform(event.messages, ctx);
		return messages === null ? undefined : { messages: messages as typeof event.messages };
	});
}
