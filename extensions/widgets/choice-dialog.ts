/**
 * A small bordered overlay that asks the user to pick one of a few options.
 * Used by the Escape-during-audit dialog and the task list confirmation.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { goalDialogControls } from "../goal-dialog-controls.ts";
import { truncateToWidth } from "./text-cache.ts";
import { t } from "../i18n/index.ts";

export interface ChoiceOption<T> {
	label: string;
	value: T;
	description: string;
}

export interface ChoiceDialog<T> {
	/** Content above the options. Each group is separated by a rule. */
	sections(theme: Theme, innerWidth: number): string[][];
	options: readonly ChoiceOption<T>[];
	initialIndex: number;
	/** Theme color of the selected label. */
	highlight: "accent" | "warning";
	cancelValue: T;
	/** Footer text after "<cancel key> = ". */
	cancelHint: string;
	maxHeight: `${number}%`;
}

/** Resolves undefined when the host cannot show a custom component. */
export async function showChoiceDialog<T>(ctx: ExtensionContext, dialog: ChoiceDialog<T>): Promise<T | undefined> {
	const controls = goalDialogControls(typeof ctx.cwd === "string" ? ctx.cwd : process.cwd());
	return await ctx.ui.custom<T | undefined>(
		(tui: TUI, theme: Theme, _keybindings: unknown, done: (result: T | undefined) => void): Component => {
			// Some web hosts invoke the factory with a render callback in place of a TUI.
			if (!tui || typeof tui.getShowHardwareCursor !== "function" || typeof tui.setShowHardwareCursor !== "function" || typeof tui.requestRender !== "function") {
				done(undefined);
				return { render: () => [], invalidate: () => {} };
			}
			const wasHardwareCursorShown = tui.getShowHardwareCursor();
			tui.setShowHardwareCursor(false);
			// Pause pi's working spinner for the dialog duration: its ~80ms re-renders
			// write output that snaps a scrolled-up user back to the terminal bottom.
			ctx.ui.setWorkingVisible(false);

			let selectedIndex = dialog.initialIndex;
			const accent = (s: string) => theme.fg("accent", s);
			const dim = (s: string) => theme.fg("dim", s);

			const component: Component & { dispose(): void } = {
				dispose() {
					tui.setShowHardwareCursor(wasHardwareCursorShown);
					ctx.ui.setWorkingVisible(true);
				},
				invalidate() {},
				render(width: number): string[] {
					const innerWidth = Math.min(width, 64) - 2;
					const line = (content: string) => borderedLine(accent, innerWidth, content);
					const rule = (left: string, right: string) => accent(left + "─".repeat(innerWidth) + right);
					const pad = "  ";
					const lines = [rule("┌", "┐")];
					for (const section of dialog.sections(theme, innerWidth)) {
						lines.push(...section.map(line), rule("├", "┤"));
					}
					dialog.options.forEach((option, i) => {
						const selected = i === selectedIndex;
						const label = selected ? theme.fg(dialog.highlight, option.label) : option.label;
						lines.push(line(pad + (selected ? "▸ " : "  ") + truncateToWidth(label, innerWidth - 6, "…")));
						if (selected) lines.push(line(pad + "    " + truncateToWidth(dim(option.description), innerWidth - 10, "…")));
					});
					const footer = dim(t("{confirm} to select  ·  {nav} to navigate  ·  {cancel} = {cancelHint}", { confirm: controls.hint("confirm"), nav: controls.navigationHint(), cancel: controls.hint("cancel"), cancelHint: dialog.cancelHint }));
					lines.push(rule("├", "┤"), line(pad + truncateToWidth(footer, innerWidth - 2, "…")), rule("└", "┘"));
					return lines;
				},
				handleInput(data: string): void {
					const count = dialog.options.length;
					if (controls.matches(data, "up")) {
						selectedIndex = (selectedIndex - 1 + count) % count;
						tui.requestRender();
					} else if (controls.matches(data, "down")) {
						selectedIndex = (selectedIndex + 1) % count;
						tui.requestRender();
					} else if (controls.matches(data, "confirm")) {
						done(dialog.options[selectedIndex]!.value);
					} else if (controls.matches(data, "cancel")) {
						done(dialog.cancelValue);
					}
				},
			};
			return component;
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 50, maxHeight: dialog.maxHeight } },
	);
}

/** One bordered line: exactly innerWidth visible chars between ││. */
function borderedLine(accent: (s: string) => string, innerWidth: number, content: string): string {
	const fill = innerWidth - visibleWidth(content);
	return accent("│") + content + (fill > 0 ? " ".repeat(fill) : "") + accent("│");
}
