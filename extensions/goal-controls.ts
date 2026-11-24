import type { KeyId } from "@earendil-works/pi-tui";

/** Stable action IDs; invocation names are preferences, not lifecycle logic. */
export const GOAL_COMMANDS = [
	["goal", "Draft a goal", "Start a guided goal with confirmation."],
	["sisyphus", "Draft a Sisyphus goal", "Draft an ordered, persistent goal."],
	["goal-direct", "Start a goal directly", "Create a goal immediately from the supplied objective."],
	["sisyphus-direct", "Start Sisyphus directly", "Create an ordered goal immediately."],
	["goal-tweak", "Revise the goal", "Revise the objective or budget, with confirmation."],
	["goal-pause", "Pause the goal", "Pause the goal and stop the current turn."],
	["goal-resume", "Resume the goal", "Continue and renew the autonomous run allowance."],
	["goal-clear", "Clear the goal", "Archive the goal after confirmation."],
	["goal-list", "List goals", "Show the open goals in this project."],
	["goal-status", "Show goal status", "Show progress; accepts verbose and health."],
	["goal-refresh", "Refresh goal state", "Read goal files and settings again."],
	["goal-recovery", "Recover goal files", "Inspect recovery information; repair requires confirmation."],
	["goal-focus", "Focus a goal", "Choose the goal this session works on."],
	["goal-unfocus", "Unfocus the goal", "Detach this session, leaving the shared goal open."],
	["goal-settings", "Goal settings", "Open settings. /goal-settings always remains available."],
	["goal-cancel", "Cancel a draft", "Cancel the guided draft without creating a goal."],
] as const;
export type GoalCommandId = typeof GOAL_COMMANDS[number][0];
export type GoalCommands = Partial<Record<GoalCommandId, string[]>>;
export const GOAL_COMMAND_INPUTS: Partial<Record<GoalCommandId, string>> = {
	"goal-direct": "Goal objective", "sisyphus-direct": "Sisyphus objective and ordered steps", "goal-tweak": "Change to the goal",
};
export type GoalKeybinding = KeyId | KeyId[];
export type PauseOrder = "together" | "goal-first" | "turn-first";

export const PAUSE_ORDERS: ReadonlyArray<{ id: PauseOrder; label: string; help: string }> = [
	{ id: "together", label: "Goal and turn together", help: "One press pauses the goal and stops the current turn." },
	{ id: "goal-first", label: "Goal first", help: "First: pause the goal; the turn finishes. Next: stop the turn." },
	{ id: "turn-first", label: "Turn first", help: "First: stop the turn and wait. Next: pause the goal. Resume or a message continues." },
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
const dashboard = (name: string, label: string, defaults: GoalKeybinding, context: GoalKeyContext, help: string): GoalKeyAction =>
	({ path: ["keybindings", "dashboard", name], label, defaults, context, help });
export const GOAL_KEY_ACTIONS: readonly GoalKeyAction[] = [
	{ path: ["keybindings", "pause"], label: "Pause / interrupt", defaults: "escape", context: "global", help: "Uses the chosen pause order. Dialogs, audit and expanded view take priority." },
	{ path: ["keybindings", "toggleAuditor"], label: "Toggle completion auditor", defaults: "ctrl+shift+a", context: "global", help: "Enable or disable the independent auditor for the focused goal." },
	dashboard("toggleExpand", "Expand / collapse dashboard", "ctrl+shift+t", "global", "Switch between the compact and expanded task list."),
	dashboard("scrollUp", "Compact: scroll up", "ctrl+shift+up", "compact", "Scroll only when the compact task list overflows."),
	dashboard("scrollDown", "Compact: scroll down", "ctrl+shift+down", "compact", "Scroll only when the compact task list overflows."),
	dashboard("scrollPageUp", "Compact: page up", "ctrl+shift+pageUp", "compact", "Scroll the compact list by one page."),
	dashboard("scrollPageDown", "Compact: page down", "ctrl+shift+pageDown", "compact", "Scroll the compact list by one page."),
	dashboard("scrollFirst", "Compact: first task", "ctrl+shift+home", "compact", "Go to the start of the compact task list."),
	dashboard("scrollLast", "Compact: last task", "ctrl+shift+end", "compact", "Go to the end of the compact task list."),
	dashboard("collapse", "Expanded: close dashboard", "escape", "expanded", "Close the expanded view without pausing work."),
	dashboard("up", "Expanded: scroll up", "up", "expanded", "Move up in the expanded task list."),
	dashboard("down", "Expanded: scroll down", "down", "expanded", "Move down in the expanded task list."),
	dashboard("pageUp", "Expanded: page up", "pageUp", "expanded", "Move one page up."),
	dashboard("pageDown", "Expanded: page down", "pageDown", "expanded", "Move one page down."),
	dashboard("first", "Expanded: first task", "home", "expanded", "Go to the start of the expanded task list."),
	dashboard("last", "Expanded: last task", "end", "expanded", "Go to the end of the expanded task list."),
	{ path: ["keybindings", "interruptAudit"], label: "Interrupt the audit", defaults: "escape", context: "audit", help: "Stop the audit and show the existing completion choices." },
	...Object.entries(GOAL_DIALOG_KEYS).map(([name, defaults]): GoalKeyAction => ({
		path: ["keybindings", "dialog", name], label: `Dialog: ${{ confirm: "confirm selection", cancel: "cancel / go back", up: "previous option", down: "next option", next: "next question", previous: "previous question", pageUp: "page up", pageDown: "page down", scrollUp: "scroll up", scrollDown: "scroll down", toggleAuditor: "toggle auditor" }[name]}`,
		defaults, context: "dialog", help: "Applies to goal questionnaires and confirmations. Settings navigation and text editing keep Pi's controls.",
	})),
	...GOAL_COMMANDS.map(([id, label, help]): GoalKeyAction => ({ path: ["keybindings", "commands", id], label, help, context: "global", defaults: [] })),
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
		if (PI_COMMAND_ROOTS.has(root) || occupiedRoots.includes(root)) problems.push(`/${root} belongs to Pi or another command.`);
		if (root === "goal-settings" && id !== "goal-settings") problems.push("/goal-settings is reserved for settings recovery.");
		const owner = owners.get(route);
		if (owner && owner !== id) problems.push(`/${route} is already assigned to ${owner}.`);
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
			if (overlap.length) problems.push(`${overlap.join(", ")} is also assigned to ${edited === b ? a.label : b.label}.`);
		}
	}
	return [...new Set(problems)];
}
