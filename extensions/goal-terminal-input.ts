import { GOAL_KEY_ACTIONS, GOAL_COMMAND_INPUTS, bindingKeys, keyActionBinding, type GoalCommandId } from "./goal-controls.ts";
import { matchesKey, getKeybindings } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadGoalSettings } from "./settings/resolve.ts";
import type {
	GoalCommandInvoker,
	GoalFocusedGoalAccess,
	GoalModalAccess,
	GoalSessionHandles,
	InterruptionSlice,
	LifecycleSlice,
	StateSlice,
	ViewSlice,
} from "./goal-core-types.ts";

/** What the terminal-input hook reads and calls when a key arrives. */
export type TerminalInputCore = GoalCommandInvoker &
	GoalFocusedGoalAccess &
	GoalModalAccess &
	GoalSessionHandles &
	StateSlice<"focusRevision" | "goalModalDepth"> &
	ViewSlice<"abortAudit" | "auditProgress" | "isDashboardExpanded" | "toggleDashboardExpanded" | "widgetRef"> &
	LifecycleSlice<"toggleAuditor"> &
	InterruptionSlice<"interruptTurn" | "pause">;

const KEY_ACTION_BY_PATH = new Map(GOAL_KEY_ACTIONS.map(action => [action.path.slice(1).join("."), action]));
const COMMAND_KEYS = GOAL_KEY_ACTIONS.filter(action => action.path[1] === "commands");
const EXPANDED_NAVIGATION = [["up", "up"], ["down", "down"], ["pageUp", "pageUp"], ["pageDown", "pageDown"], ["first", "home"], ["last", "end"]] as const;
const COMPACT_NAVIGATION = [["scrollUp", "up"], ["scrollDown", "down"], ["scrollPageUp", "pageUp"], ["scrollPageDown", "pageDown"], ["scrollFirst", "home"], ["scrollLast", "end"]] as const;

function isKittyRepeatOrRelease(data: string): boolean {
	return data.startsWith("\x1b[") && /^[0-9:;]+:[23][u~ABCDHF]$/.test(data.slice(2));
}

/**
 * Terminal input keybindings: Escape pause/abort-audit, dashboard
 * expand/navigation, auditor toggle, and configured command shortcuts.
 * Re-registered at session start/tree navigation; the handler reads live
 * state through the core at event time.
 */
export function syncTerminalInputPause(core: TerminalInputCore, ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		core.terminalInputUnsubscribe?.();
		const goalCwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
		core.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			// The active dialog owns every key, including key capture and Escape.
			if (core.state.goalModalDepth > 0) return undefined;
			if (core.view.widgetRef.current?.isMainEditorFocused?.() === false) return undefined;
			const settings = loadGoalSettings(goalCwd);
			const matches = (path: string): boolean => {
				const action = KEY_ACTION_BY_PATH.get(path)!;
				return bindingKeys(keyActionBinding(settings, action)).some(key => matchesKey(data, key));
			};
			if (isKittyRepeatOrRelease(data)) {
				const applicable = GOAL_KEY_ACTIONS.filter(action => action.context === "global" ||
					(core.view.auditProgress ? action.context === "audit" : core.view.isDashboardExpanded() ? action.context === "expanded" : action.context === "compact"));
				return applicable.some(action => bindingKeys(keyActionBinding(settings, action)).some(key => matchesKey(data, key))) ? { consume: true } : undefined;
			}
			if (core.view.auditProgress && matches("interruptAudit")) { core.view.abortAudit(); return { consume: true }; }
			if (core.view.isDashboardExpanded() && matches("dashboard.collapse")) { core.view.toggleDashboardExpanded(); return { consume: true }; }
			if (matches("pause") && ((core.state.goal?.status === "active" && core.state.goal.autoContinue) || (core.state.goal?.status === "paused" && !ctx.isIdle()))) {
				core.interruption.pause(ctx);
				// Preserve Pi's ordinary Escape handling for the default combined stop.
				return matchesKey(data, "escape") && settings.pauseOrder === "together" ? undefined : { consume: true };
			}
			// Follow Pi's configured interrupt key.
			let hostInterrupt = matchesKey(data, "escape");
			try {
				const manager = getKeybindings();
				const keys = manager.getKeys("app.interrupt");
				if (keys.length) hostInterrupt = keys.some(key => matchesKey(data, key));
			} catch { /* Embeddings without an app keymap retain Escape. */ }
			if (hostInterrupt && !matches("pause") && core.state.goal?.status === "active" && core.state.goal.autoContinue) {
				core.interruption.interruptTurn(ctx); return { consume: true };
			}
			if (matches("dashboard.toggleExpand")) { core.view.toggleDashboardExpanded(); return { consume: true }; }
			if (matches("toggleAuditor")) {
				core.lifecycle.toggleAuditor(ctx); core.view.widgetRef.current?.invalidate(); return { consume: true };
			}
			if (core.view.isDashboardExpanded()) {
				for (const [name, key] of EXPANDED_NAVIGATION) if (matches(`dashboard.${name}`) && core.view.widgetRef.current?.handleNavigationKey(key)) return { consume: true };
			} else {
				for (const [name, key] of COMPACT_NAVIGATION) if (matches(`dashboard.${name}`) && core.view.widgetRef.current?.handleCompactScrollKey(key)) return { consume: true };
			}
			for (const action of COMMAND_KEYS) {
				if (!bindingKeys(keyActionBinding(settings, action)).some(key => matchesKey(data, key))) continue;
				const id = action.path[2] as GoalCommandId;
				const revision = core.state.focusRevision;
				const owner = core.sessionOwner;
				void (async () => {
					core.state.enterModal();
					try {
						const prompt = GOAL_COMMAND_INPUTS[id];
						const args = prompt ? await ctx.ui.input(prompt) : "";
						if (core.state.focusRevision !== revision || args === undefined || (prompt && !args.trim())) return;
						await core.invokeGoalCommand?.(id, args, ctx);
					} finally { if (core.sessionOwner === owner) core.state.exitModal(); }
				})().catch(error => {if (core.sessionOwner === owner) ctx.ui.notify(String(error), "error");});
				return { consume: true };
			}

			return undefined;
		});
}
