import type { KeyId } from "@earendil-works/pi-tui";
import { t } from "./i18n/index.ts";

/** Stable action IDs; invocation names are preferences, not lifecycle logic. */
/** Label and help are read lazily, so they follow the language chosen at startup. */
const command = <const Id extends string>(id: Id, label: () => string, help: () => string): readonly [Id, string, string] => {
	const row: [Id, string, string] = [id, "", ""];
	Object.defineProperties(row, { 1: { get: label, enumerable: true }, 2: { get: help, enumerable: true } });
	return row;
};
export const GOAL_COMMANDS = [
	command("goal", () => t("Draft a goal"), () => t("Start a guided goal with confirmation.")),
	command("sisyphus", () => t("Draft a Sisyphus goal"), () => t("Draft an ordered, persistent goal.")),
	command("goal-direct", () => t("Start a goal directly"), () => t("Create a goal immediately from the supplied objective.")),
	command("sisyphus-direct", () => t("Start Sisyphus directly"), () => t("Create an ordered goal immediately.")),
	command("goal-tweak", () => t("Revise the goal"), () => t("Revise the objective or budget, with confirmation.")),
	command("goal-pause", () => t("Pause the goal"), () => t("Pause the goal and stop the current turn.")),
	command("goal-resume", () => t("Resume the goal"), () => t("Continue and renew the autonomous run allowance.")),
	command("goal-clear", () => t("Clear the goal"), () => t("Archive the goal after confirmation.")),
	command("goal-list", () => t("List goals"), () => t("Show the open goals in this project.")),
	command("goal-status", () => t("Show goal status"), () => t("Show progress; accepts verbose and health.")),
	command("goal-refresh", () => t("Refresh goal state"), () => t("Read goal files and settings again.")),
	command("goal-recovery", () => t("Recover goal files"), () => t("Inspect recovery information; repair requires confirmation.")),
	command("goal-focus", () => t("Focus a goal"), () => t("Choose the goal this session works on.")),
	command("goal-unfocus", () => t("Unfocus the goal"), () => t("Detach this session, leaving the shared goal open.")),
	command("goal-settings", () => t("Goal settings"), () => t("Open settings. /goal-settings always remains available.")),
	command("goal-cancel", () => t("Cancel a draft"), () => t("Cancel the guided draft without creating a goal.")),
] as const;
export type GoalCommandId = typeof GOAL_COMMANDS[number][0];
export type GoalCommands = Partial<Record<GoalCommandId, string[]>>;
export const GOAL_COMMAND_INPUTS: Partial<Record<GoalCommandId, string>> = {
	get "goal-direct"() { return t("Goal objective"); },
	get "sisyphus-direct"() { return t("Sisyphus objective and ordered steps"); },
	get "goal-tweak"() { return t("Change to the goal"); },
};
export type GoalKeybinding = KeyId | KeyId[];
export type PauseOrder = "together" | "goal-first" | "turn-first";

export const PAUSE_ORDERS: ReadonlyArray<{ id: PauseOrder; label: string; help: string }> = [
	{ id: "together", get label() { return t("Goal and turn together"); }, get help() { return t("One press pauses the goal and stops the current turn."); } },
	{ id: "goal-first", get label() { return t("Goal first"); }, get help() { return t("First: pause the goal; the turn finishes. Next: stop the turn."); } },
	{ id: "turn-first", get label() { return t("Turn first"); }, get help() { return t("First: stop the turn and wait. Next: pause the goal. Resume or a message continues."); } },
];

type GoalKeyContext = "global" | "compact" | "expanded" | "audit" | "dialog";
export const GOAL_DIALOG_KEYS = {
	confirm: "enter", cancel: "escape", up: "up", down: "down", next: ["tab", "right"], previous: ["shift+tab", "left"],
	pageUp: "pageUp", pageDown: "pageDown", scrollUp: "ctrl+up", scrollDown: "ctrl+down", toggleAuditor: "a",
} satisfies Record<string, GoalKeybinding>;
export type GoalDialogAction = keyof typeof GOAL_DIALOG_KEYS;
export interface GoalKeyAction {
	path: string[];
	label: string;
	help: string;
	context: GoalKeyContext;
	defaults: GoalKeybinding;
}
/** Label and help are read lazily, so they follow the language chosen at startup. */
const keyAction = (path: string[], label: () => string, defaults: GoalKeybinding, context: GoalKeyContext, help: () => string): GoalKeyAction =>
	({ path, get label() { return label(); }, defaults, context, get help() { return help(); } });
const dashboard = (name: string, label: () => string, defaults: GoalKeybinding, context: GoalKeyContext, help: () => string): GoalKeyAction =>
	keyAction(["keybindings", "dashboard", name], label, defaults, context, help);
const DIALOG_KEY_LABELS: Record<GoalDialogAction, () => string> = {
	confirm: () => t("Dialog: confirm selection"),
	cancel: () => t("Dialog: cancel / go back"),
	up: () => t("Dialog: previous option"),
	down: () => t("Dialog: next option"),
	next: () => t("Dialog: next question"),
	previous: () => t("Dialog: previous question"),
	pageUp: () => t("Dialog: page up"),
	pageDown: () => t("Dialog: page down"),
	scrollUp: () => t("Dialog: scroll up"),
	scrollDown: () => t("Dialog: scroll down"),
	toggleAuditor: () => t("Dialog: toggle auditor"),
};
export const GOAL_KEY_ACTIONS: readonly GoalKeyAction[] = [
	keyAction(["keybindings", "pause"], () => t("Pause / interrupt"), "escape", "global", () => t("Uses the chosen pause order. Dialogs, audit and expanded view take priority.")),
	keyAction(["keybindings", "toggleAuditor"], () => t("Toggle completion auditor"), "ctrl+shift+a", "global", () => t("Enable or disable the independent auditor for the focused goal.")),
	dashboard("toggleExpand", () => t("Expand / collapse dashboard"), "ctrl+shift+t", "global", () => t("Switch between the compact and expanded task list.")),
	dashboard("scrollUp", () => t("Compact: scroll up"), "ctrl+shift+up", "compact", () => t("Scroll only when the compact task list overflows.")),
	dashboard("scrollDown", () => t("Compact: scroll down"), "ctrl+shift+down", "compact", () => t("Scroll only when the compact task list overflows.")),
	dashboard("scrollPageUp", () => t("Compact: page up"), "ctrl+shift+pageUp", "compact", () => t("Scroll the compact list by one page.")),
	dashboard("scrollPageDown", () => t("Compact: page down"), "ctrl+shift+pageDown", "compact", () => t("Scroll the compact list by one page.")),
	dashboard("scrollFirst", () => t("Compact: first task"), "ctrl+shift+home", "compact", () => t("Go to the start of the compact task list.")),
	dashboard("scrollLast", () => t("Compact: last task"), "ctrl+shift+end", "compact", () => t("Go to the end of the compact task list.")),
	dashboard("collapse", () => t("Expanded: close dashboard"), "escape", "expanded", () => t("Close the expanded view without pausing work.")),
	dashboard("up", () => t("Expanded: scroll up"), "up", "expanded", () => t("Move up in the expanded task list.")),
	dashboard("down", () => t("Expanded: scroll down"), "down", "expanded", () => t("Move down in the expanded task list.")),
	dashboard("pageUp", () => t("Expanded: page up"), "pageUp", "expanded", () => t("Move one page up.")),
	dashboard("pageDown", () => t("Expanded: page down"), "pageDown", "expanded", () => t("Move one page down.")),
	dashboard("first", () => t("Expanded: first task"), "home", "expanded", () => t("Go to the start of the expanded task list.")),
	dashboard("last", () => t("Expanded: last task"), "end", "expanded", () => t("Go to the end of the expanded task list.")),
	keyAction(["keybindings", "interruptAudit"], () => t("Interrupt the audit"), "escape", "audit", () => t("Stop the audit and show the existing completion choices.")),
	...Object.entries(GOAL_DIALOG_KEYS).map(([name, defaults]) => keyAction(
		["keybindings", "dialog", name], DIALOG_KEY_LABELS[name as GoalDialogAction], defaults, "dialog",
		() => t("Applies to goal questionnaires and confirmations. Settings navigation and text editing keep Pi's controls."),
	)),
	...GOAL_COMMANDS.map(([id], index): GoalKeyAction => keyAction(
		["keybindings", "commands", id], () => GOAL_COMMANDS[index]![1], [], "global", () => GOAL_COMMANDS[index]![2],
	)),
];

export function valueAtPath(value: unknown, path: readonly string[]): unknown {
	let cursor = value;
	for (const part of path) {
		if (!cursor || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[part];
	}
	return cursor;
}
export function bindingKeys(binding: GoalKeybinding | undefined): KeyId[] {
	return binding === undefined ? [] : Array.isArray(binding) ? binding : [binding];
}
export function keyActionBinding(settings: unknown, action: GoalKeyAction): GoalKeybinding {
	return (valueAtPath(settings, action.path) as GoalKeybinding | undefined) ?? action.defaults;
}

/** Used only while editing, so validation can consider both scopes before a write. */
export function resolveGoalControls(global: unknown, project?: unknown): { commands: GoalCommands; keybindings: Record<string, unknown> } {
	const value = { commands: {} as GoalCommands, keybindings: {} as Record<string, unknown> };
	for (const [id] of GOAL_COMMANDS) value.commands[id] = (valueAtPath(project, ["commands", id]) ?? valueAtPath(global, ["commands", id]) ?? [id]) as string[];
	for (const action of GOAL_KEY_ACTIONS) {
		let target: Record<string, unknown> = value;
		for (const part of action.path.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
		target[action.path.at(-1)!] = valueAtPath(project, action.path) ?? valueAtPath(global, action.path) ?? action.defaults;
	}
	return value;
}

const specialKeys = new Map("escape enter tab space backspace delete insert clear home end pageUp pageDown up down left right f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12".split(" ").map(key => [key.toLowerCase(), key]));
/** Accept the public Pi key grammar, canonicalizing aliases and modifier order. */
export function normalizeGoalKey(value: unknown): KeyId | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	let text = value.trim().toLowerCase();
	if (text === "esc") text = "escape";
	if (text === "return") text = "enter";
	const modifiers: string[] = [];
	while (/^(ctrl|shift|alt|super)\+/.test(text)) {
		const i = text.indexOf("+");
		const modifier = text.slice(0, i);
		if (modifiers.includes(modifier)) return undefined;
		modifiers.push(modifier); text = text.slice(i + 1);
	}
	text = text === "esc" ? "escape" : text === "return" ? "enter" : text;
	const key = specialKeys.get(text) ?? (/^[a-z0-9`\-=[\]\\;'",./!@#$%^&*()_+|~{}:<>?]$/.test(text) ? text : undefined);
	if (!key) return undefined;
	return [...["ctrl", "alt", "shift", "super"].filter(m => modifiers.includes(m)), key].join("+") as KeyId;
}
export function parseGoalKeybinding(value: unknown): GoalKeybinding | undefined {
	if (typeof value === "string") return normalizeGoalKey(value);
	if (!Array.isArray(value) || value.length > 16) return undefined;
	const keys = value.map(normalizeGoalKey);
	return keys.every((key): key is KeyId => key !== undefined) ? [...new Set(keys)] : undefined;
}

export function sameGoalKey(a: string, b: string, kitty = false): boolean {
	const physical = (key: string) => kitty ? key : ({ "ctrl+[": "escape", "ctrl+m": "enter", "ctrl+i": "tab", "ctrl+h": "backspace", "ctrl+?": "backspace", "ctrl+@": "ctrl+space" }[key] ?? key);
	return physical(normalizeGoalKey(a) ?? a) === physical(normalizeGoalKey(b) ?? b);
}

const PI_COMMAND_ROOTS = new Set("settings model tree thinking scoped-models export import share bug copy name session changelog hotkeys fork clone trust login logout new compact resume reload quit".split(" "));
function normalizeCommandPath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const route = value.trim().replace(/^\//, "").replace(/\s+/g, " ");
	return route.length <= 96 && /^[a-z][a-z0-9_-]*(?: [a-z][a-z0-9_-]*)*$/.test(route) ? route : undefined;
}
export function parseCommandPaths(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > 16) return undefined;
	const paths = value.map(normalizeCommandPath);
	return paths.every((route): route is string => route !== undefined) ? [...new Set(paths)] : undefined;
}
export function commandPaths(commands: GoalCommands | undefined, id: GoalCommandId): string[] {
	return commands?.[id] ?? [id];
}
export function commandHint(id: GoalCommandId, commands?: GoalCommands): string {
	const first = commandPaths(commands, id)[0];
	if (!first && id === "goal-settings") return "/goal-settings";
	return first ? `/${first}` : `/goal-settings controls to enable ${GOAL_COMMANDS.find(([action]) => action === id)![1].toLowerCase()}`;
}
const commandReference = new RegExp(`/(${GOAL_COMMANDS.map(([id]) => id).sort((a, b) => b.length - a.length).join("|")})(?![a-z0-9_-])`, "g");
/** For standing instructions only: objectives and other user text stay verbatim. */
export function commandInstructions(text: string, commands?: GoalCommands): string {
	return commands ? text.replace(commandReference, (_match, id: GoalCommandId) => commandHint(id, commands)) : text;
}
interface GoalCommandRoute { path: string; id: GoalCommandId }
export function commandRoutes(commands: GoalCommands | undefined): GoalCommandRoute[] {
	const routes = GOAL_COMMANDS.flatMap(([id]) => commandPaths(commands, id).map(path => ({ path, id })));
	if (!routes.some(route => route.path === "goal-settings")) routes.push({ path: "goal-settings", id: "goal-settings" });
	return routes.sort((a, b) => b.path.length - a.path.length);
}
export function commandProblems(commands: GoalCommands | undefined, occupiedRoots: readonly string[] = []): string[] {
	const problems: string[] = [];
	const owners = new Map<string, GoalCommandId>();
	for (const [id] of GOAL_COMMANDS) for (const route of commandPaths(commands, id)) {
		const root = route.split(" ")[0]!;
		if (PI_COMMAND_ROOTS.has(root) || occupiedRoots.includes(root)) problems.push(t("/{root} belongs to Pi or another command.", { root }));
		if (root === "goal-settings" && id !== "goal-settings") problems.push(t("/goal-settings is reserved for settings recovery."));
		const owner = owners.get(route);
		if (owner && owner !== id) problems.push(t("/{route} is already assigned to {owner}.", { route, owner }));
		owners.set(route, id);
	}
	return [...new Set(problems)];
}
export function matchCommandRoute(routes: readonly GoalCommandRoute[], root: string, args: string): { id: GoalCommandId; args: string } | undefined {
	const input = root + (args ? ` ${args}` : "");
	for (const route of routes) {
		const matched = new RegExp(`^${route.path.split(" ").join("\\s+")}(?=$|\\s)`).exec(input);
		if (matched) return { id: route.id, args: input.slice(matched[0].length).trimStart() };
	}
	return undefined;
}

/** Global keys overlap both dashboard modes; view-specific handlers own Escape first. */
export function keybindingProblems(settings: unknown, edited?: GoalKeyAction, kitty = false): string[] {
	const problems: string[] = [];
	for (let i = 0; i < GOAL_KEY_ACTIONS.length; i++) {
		const a = GOAL_KEY_ACTIONS[i]!;
		for (const b of GOAL_KEY_ACTIONS.slice(i + 1)) {
			if (edited && a !== edited && b !== edited) continue;
			if ((a.context === "dialog") !== (b.context === "dialog")) continue;
			if (a.context !== b.context && a.context !== "global" && b.context !== "global") continue;
			// These view-specific actions deliberately take priority over pause.
			if ((a.path[1] === "pause" || b.path[1] === "pause") && [a, b].some(x => x.path[1] === "interruptAudit" || x.path[2] === "collapse")) continue;
			const overlap = bindingKeys(keyActionBinding(settings, a)).filter(key => bindingKeys(keyActionBinding(settings, b)).some(bound => sameGoalKey(key, bound, kitty)));
			if (overlap.length) problems.push(t("{keys} is also assigned to {action}.", { keys: overlap.join(", "), action: edited === b ? a.label : b.label }));
		}
	}
	return [...new Set(problems)];
}
