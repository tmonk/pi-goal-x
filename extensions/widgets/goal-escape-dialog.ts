import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "./text-cache.ts";
import { showChoiceDialog } from "./choice-dialog.ts";

/**
 * Result of the Escape dialog during audit.
 */
type EscapeDialogResult = "complete_without_audit" | "continue_working";

/**
 * Show a TUI confirmation dialog when the user presses Escape during a completion audit.
 *
 * Presents two choices:
 *   - Mark complete without audit (skips auditor, marks goal complete immediately)
 *   - Continue working (returns to agent, goal stays active)
 *
 * Returns the user's choice. Escape or Enter on a focused option submits the selection.
 */
export async function showEscapeDialog(
	ctx: ExtensionContext,
	goalObjective: string,
): Promise<EscapeDialogResult> {
	if (!ctx.hasUI) {
		// Fallback for headless/RPC mode — return "continue" as the safe default
		return "continue_working";
	}

	const choice = await showChoiceDialog<EscapeDialogResult>(ctx, {
		sections: (theme, innerWidth) => {
			const dim = (s: string) => theme.fg("dim", s);
			return [[
				truncateToWidth("  " + theme.bold("Audit interrupted") + dim("  (continue = default)"), innerWidth, "…"),
				"  " + dim("Goal: ") + dim(truncateToWidth(goalObjective, innerWidth - 14, "…")),
			]];
		},
		options: [
			{
				label: "Mark complete without audit",
				value: "complete_without_audit",
				description: "Bypass the auditor and mark the goal complete now.",
			},
			{
				label: "Continue working",
				value: "continue_working",
				description: "Resume work on the goal. It stays active; the audit will not run this turn.",
			},
		],
		initialIndex: 1,
		highlight: "warning",
		cancelValue: "continue_working",
		cancelHint: "continue working",
		maxHeight: "50%",
	});
	return choice ?? "continue_working";
}
