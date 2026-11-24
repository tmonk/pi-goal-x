import { getKeybindings, isKittyProtocolActive, matchesKey } from "@earendil-works/pi-tui";
import { GOAL_DIALOG_KEYS, bindingKeys, sameGoalKey, type GoalDialogAction, type GoalKeybinding } from "./goal-controls.ts";
import { formatGoalKeybinding } from "./settings/schema.ts";
import { loadGoalSettings } from "./settings/resolve.ts";

/** Snapshot the dialog's controls once; the modal owns input until it closes. */
export function goalDialogControls(cwd: string) {
	const configured = loadGoalSettings(cwd).keybindings?.dialog;
	const binding = (action: GoalDialogAction) => configured?.[action] ?? GOAL_DIALOG_KEYS[action];
	const hint = (action: GoalDialogAction) => action === "toggleAuditor" && binding(action) === "a" ? "a" : formatGoalKeybinding(binding(action));
	let editorKeys: string[] = [];
	try { editorKeys = Object.entries(getKeybindings().getResolvedBindings()).filter(([id]) => /^tui\.(editor|input)\./.test(id)).flatMap(([, keys]) => bindingKeys(keys)); } catch { /* Older keymap inspection is optional. */ }
	const safeWhileEditing = (key: string) => {
		const textKey = key.replace(/^shift\+/, "");
		if (textKey.length === 1 || textKey === "space" || key === "left" || key === "right") return false;
		// Tab has always switched questions from the answer editor.
		return key === "tab" || key === "shift+tab" || !editorKeys.some(native => sameGoalKey(native, key, isKittyProtocolActive()));
	};
	const editingBindings = new Map(Object.keys(GOAL_DIALOG_KEYS).map(action => {
		const id = action as GoalDialogAction;
		return [id, bindingKeys(binding(id)).filter(safeWhileEditing)] as const;
	}));
	const matches = (data: string, action: GoalDialogAction, editing = false) => (editing ? editingBindings.get(action)! : bindingKeys(binding(action))).some(key => matchesKey(data, key));
	return {
		matches,
		cancelEditing: (data: string) => matchesKey(data, "escape") || matches(data, "cancel", true),
		editorCancelHint: () => formatGoalKeybinding([...new Set(["escape", ...editingBindings.get("cancel")!])] as GoalKeybinding),
		hint,
		navigationHint: () => hint("up") === "↑" && hint("down") === "↓" ? "↑↓" : `${hint("up")} / ${hint("down")}`,
		pagingHint: () => `${hint("pageUp")}/${hint("pageDown")}`.replaceAll("PageUp", "PgUp").replaceAll("PageDown", "PgDn"),
	};
}
