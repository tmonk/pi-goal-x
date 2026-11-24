import { goalDialogControls } from "../goal-dialog-controls.ts";
import { truncateToWidth } from "./text-cache.ts";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { borderedLine, dialogInnerWidth, horizontalRule } from "./dialog-scaffold.ts";

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

	const controls = goalDialogControls(typeof ctx.cwd === "string" ? ctx.cwd : process.cwd());
	return await ctx.ui.custom<EscapeDialogResult>(
		(tui: TUI, theme: Theme, _keybindings: unknown, done: (result: EscapeDialogResult) => void): Component => {
			const wasHardwareCursorShown = tui.getShowHardwareCursor();
			tui.setShowHardwareCursor(false);
			// Pause pi's working spinner for the dialog duration: its ~80ms re-renders
			// write output that snaps a scrolled-up user back to the terminal bottom.
			ctx.ui.setWorkingVisible(false);

			let selectedIndex = 1; // Default: "Continue working" (index 1)
			let cancelled = false;

			const OPTIONS: Array<{ label: string; value: EscapeDialogResult; description: string }> = [
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
			];

			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);
			const warning = (s: string) => theme.fg("warning", s);

			// ── Component ────────────────────────────────────────────────────
			const component: Component & { dispose?(): void } = {
				dispose() {
					tui.setShowHardwareCursor(wasHardwareCursorShown);
					ctx.ui.setWorkingVisible(true);
				},

				invalidate(): void {
					// No cached state to invalidate
				},

				render(width: number): string[] {
					const termWidth = Math.min(width, 80);
					const innerWidth = dialogInnerWidth(termWidth);

					const line = (leftContent: string): string => borderedLine(accent, innerWidth, leftContent);

					const horizLine = horizontalRule(innerWidth);
					const lines: string[] = [];
					const p = "  "; // left padding inside the border

					// ── Header ────────────────────────────────────────────────
					lines.push(accent(`┌${horizLine}┐`));
					const headerContent = p + theme.bold("Audit interrupted") + dim("  (continue = default)");
					lines.push(line(truncateToWidth(headerContent, innerWidth, "…")));
					const truncatedObjective = truncateToWidth(goalObjective, innerWidth - 14, "…");
					lines.push(line(p + dim("Goal: ") + dim(truncatedObjective)));
					lines.push(accent(`├${horizLine}┤`));

					// ── Options ─────────────────────────────────────────────
					OPTIONS.forEach((opt, i) => {
						const isSelected = i === selectedIndex && !cancelled;
						const marker = isSelected ? "▸ " : "  ";
						const label = isSelected ? warning(opt.label) : opt.label;
						const truncLabel = truncateToWidth(label, innerWidth - 6, "…");
						lines.push(line(p + marker + truncLabel));
						if (isSelected && opt.description) {
							const desc = dim(opt.description);
							const truncDesc = truncateToWidth(desc, innerWidth - 10, "…");
							lines.push(line(p + " ".repeat(4) + truncDesc));
						}
					});

					// ── Footer ───────────────────────────────────────────────
					lines.push(accent(`├${horizLine}┤`));
					const footerText = dim(`${controls.hint("confirm")} to select  ·  ${controls.navigationHint()} to navigate  ·  ${controls.hint("cancel")} = continue working`);
						const truncFooter = truncateToWidth(footerText, innerWidth - 2, "…");
					lines.push(line(p + truncFooter));
					lines.push(accent(`└${horizLine}┘`));

					return lines;
				},

				handleInput(data: string): void {
					if (controls.matches(data, "up")) {
						selectedIndex = (selectedIndex - 1 + OPTIONS.length) % OPTIONS.length;
						tui.requestRender();
						return;
					}
					if (controls.matches(data, "down")) {
						selectedIndex = (selectedIndex + 1) % OPTIONS.length;
						tui.requestRender();
						return;
					}
					if (controls.matches(data, "confirm")) {
						cancelled = false;
						done(OPTIONS[selectedIndex]!.value);
						return;
					}
					if (controls.matches(data, "cancel")) {
						cancelled = true;
						done("continue_working");
						return;
					}
				},
			};

			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "70%",
				minWidth: 50,
				maxHeight: "50%",
			},
		},
	);
}
