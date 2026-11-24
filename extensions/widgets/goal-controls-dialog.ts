import { Input, isKittyProtocolActive, matchesKey, parseKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TUI, KeyId } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	GOAL_COMMANDS, GOAL_KEY_ACTIONS, PAUSE_ORDERS, bindingKeys, commandPaths, commandProblems,
	commandRoutes, keybindingProblems, normalizeGoalKey, parseCommandPaths, parseGoalKeybinding, resolveGoalControls, sameGoalKey, valueAtPath,
	type GoalKeyAction, type GoalKeybinding,
} from "../goal-controls.ts";
import { formatGoalKeybinding, type GoalSettings, type SettingsScope } from "../settings/schema.ts";
import { invalidateGoalSettingsCache } from "../settings/files.ts";
import { loadSettingsSnapshot, type SettingsSnapshot } from "../settings/resolve.ts";
import { mutateSettingsLayer, type SettingsMutation } from "../settings/mutate.ts";
import type { GoalCore } from "../goal-state.ts";
import { truncateToWidth } from "./text-cache.ts";

type Tab = "Commands" | "Keys" | "Pausing";
type Row = { label: string; path: string[]; help: string; kind: "commands" | "keys" | "order" | "reset"; defaults: unknown; action?: GoalKeyAction };
const TABS: Tab[] = ["Commands", "Keys", "Pausing"];
const rowsFor = (tab: Tab): Row[] => tab === "Commands"
	? GOAL_COMMANDS.map(([id, label, help]) => ({ label, path: ["commands", id], help, kind: "commands", defaults: [id] }))
	: tab === "Keys"
		? GOAL_KEY_ACTIONS.map(action => ({ label: action.path[1] === "commands" ? `Command: ${action.label}` : action.label, path: action.path, help: action.help, kind: "keys", defaults: action.defaults, action }))
		: [{ label: "Pause order", path: ["pauseOrder"], help: "Choose what happens on the first and second press of the pause key.", kind: "order", defaults: "together" }];

export function commandControlsFingerprint(commands: GoalSettings["commands"]): string {
	return JSON.stringify(GOAL_COMMANDS.map(([id]) => [id, commandPaths(commands, id)]));
}

/** Bounded, model-free settings UI. The parent owns modal isolation and reload. */
export class GoalControlsDialog implements Component {
	private snapshot: SettingsSnapshot;
	private scope: SettingsScope = "project";
	private tabIndex = 0;
	private selection = [0, 0, 0];
	private query = new Input();
	private editor = new Input();
	private view: "list" | "actions" | "input" | "capture" | "key-preview" = "list";
	private row: Row | undefined;
	private actionIndex = 0;
	private adding = false;
	private recorded: KeyId | undefined;
	private notice = "";
	private error = "";
	private closed = false;
	private pageSize = 8;
	private showCursor: boolean;
	private core: GoalCore;
	private ctx: ExtensionContext;
	private tui: TUI;
	private theme: Theme;
	private keymap: KeybindingsManager;
	private done: (result: "reload" | undefined) => void;
	constructor(core: GoalCore, ctx: ExtensionContext, tui: TUI, theme: Theme, keymap: KeybindingsManager, done: (result: "reload" | undefined) => void, scope: SettingsScope = "project") {
		this.core = core; this.ctx = ctx; this.tui = tui; this.theme = theme; this.keymap = keymap; this.done = done;
		this.scope = scope;
		this.snapshot = loadSettingsSnapshot(ctx.cwd);
		this.showCursor = tui.getShowHardwareCursor();
		tui.setShowHardwareCursor(false);
		ctx.ui.setWorkingVisible(false);
		this.editor.onSubmit = () => this.saveInput();
		this.editor.onEscape = () => { this.view = "actions"; this.error = ""; };
	}
	dispose(): void { this.tui.setShowHardwareCursor(this.showCursor); this.ctx.ui.setWorkingVisible(true); }
	invalidate(): void {}
	private get tab(): Tab { return TABS[this.tabIndex]!; }
	private pending(): boolean { return commandControlsFingerprint(this.snapshot.value.commands) !== commandControlsFingerprint(this.core.loadedCommands); }
	private rows(): Row[] {
		const query = this.query.getValue().toLowerCase().trim();
		const rows = rowsFor(this.tab).filter(row => `${row.label} ${row.help} ${this.display(row, this.setting(row))}`.toLowerCase().includes(query));
		if (!query) rows.push({ label: `Reset ${this.tab.toLowerCase()} overrides…`, path: [this.tab === "Commands" ? "commands" : this.tab === "Keys" ? "keybindings" : "pauseOrder"], kind: "reset", defaults: undefined, help: `Remove only ${this.scope} overrides in this section.`, });
		return rows;
	}
	private inherited(row: Row): unknown { return (this.scope === "project" ? valueAtPath(this.snapshot.global.layer, row.path) : undefined) ?? row.defaults; }
	private setting(row: Row): unknown { return valueAtPath(this.snapshot[this.scope].layer, row.path) ?? this.inherited(row); }
	private source(row: Row): string {
		if (row.kind === "reset") return "";
		if (valueAtPath(this.snapshot[this.scope].layer, row.path) !== undefined) return this.scope;
		if (this.scope === "project" && valueAtPath(this.snapshot.global.layer, row.path) !== undefined) return "global";
		return "default";
	}
	private display(row: Row, value: unknown): string {
		if (row.kind === "commands") return (value as string[]).map(route => `/${route}`).join(", ") || (row.path[1] === "goal-settings" ? "/goal-settings (recovery only)" : "Disabled");
		if (row.kind === "keys") return formatGoalKeybinding(value as GoalKeybinding);
		if (row.kind === "order") return PAUSE_ORDERS.find(order => order.id === value)?.label ?? "Goal and turn together";
		return "";
	}
	private options(): string[] {
		if (this.row?.kind === "reset") return [`Remove ${this.scope} overrides`, "Back"];
		if (this.row?.kind === "order") return [...PAUSE_ORDERS.map(order => order.label), this.inheritLabel(), "Back"];
		return [
			...(this.row?.kind === "commands" ? ["Edit command paths", "Add an alias"] : ["Record a replacement key", "Record another key", "Edit key names"]),
			this.row?.path[1] === "goal-settings" ? "Recovery entry only" : "Disable", "Use default", this.inheritLabel(), "Back",
		];
	}
	private inheritLabel(): string { return this.scope === "project" ? "Use inherited value" : "Remove global override"; }
	private optionHelp(): string {
		const row = this.row!;
		const option = this.options()[this.actionIndex];
		if (option === this.inheritLabel()) return `Inherited: ${this.display(row, this.inherited(row))}. Remove this scope's override.`;
		if (option === "Use default") return `Default: ${this.display(row, row.defaults)}. Keep this value in ${this.scope === "project" ? "this project" : "all projects"}, even if the inherited value changes.`;
		if (option === "Back") return "Return without changing this control.";
		if (row.kind === "order") return PAUSE_ORDERS[this.actionIndex]!.help;
		if (row.kind === "reset") return row.help;
		if (option === "Recovery entry only") return "Remove additional settings commands. /goal-settings always remains available.";
		if (option === "Disable") return row.kind === "commands" ? "Remove slash commands for this action. Any command shortcut still works." : "Remove this action's keys in the selected scope.";
		if (option === "Add an alias") return "Keep the current names and add another command. The first name stays preferred.";
		return row.help;
	}
	private mutate(mutation: SettingsMutation): boolean {
		try {
			this.snapshot = mutateSettingsLayer({ scope: this.scope, cwd: this.ctx.cwd, mutation, validate: (next, current) => {
				// Another session may have edited a different leaf since this screen opened.
				invalidateGoalSettingsCache();
				const snapshot = loadSettingsSnapshot(this.ctx.cwd);
				const global = this.scope === "global" ? current : snapshot.global.layer;
				const project = this.scope === "project" ? current : snapshot.project.layer;
				const nextGlobal = this.scope === "global" ? next : global;
				const nextProject = this.scope === "project" ? next : project;
				const before = [resolveGoalControls(global), resolveGoalControls(global, project)];
				const after = [resolveGoalControls(nextGlobal), resolveGoalControls(nextGlobal, nextProject)];
				const edited = GOAL_KEY_ACTIONS.find(action => action.path.join(".") === mutation.path.join("."));
				const problems = (values: typeof before) => values.flatMap(value => mutation.path[0] === "commands" ? commandProblems(value.commands) : keybindingProblems(value, edited, isKittyProtocolActive()));
				const existing = new Set(problems(before));
				const introduced = problems(after).find(problem => !existing.has(problem));
				if (introduced) throw new Error(introduced);
			} });
			this.core.updateUI(this.ctx);
			this.error = "";
			const masked = this.scope === "global" && valueAtPath(this.snapshot.project.layer, mutation.path) !== undefined;
			this.notice = masked ? "Saved for all projects. Project overrides still apply."
				: mutation.path[0] === "commands" && this.pending() ? ("reload" in this.ctx ? "Saved. Ctrl+R applies commands when Pi is idle." : "Saved. Close controls and run /reload to apply commands.")
					: "Saved. Changes are active now.";
			this.view = "list";
			return true;
		} catch (error) { this.error = error instanceof Error ? error.message : String(error); return false; }
	}
	private save(value: unknown): void {
		const row = this.row!;
		// Validate against a fresh merged snapshot, including other scopes.
		this.snapshot = loadSettingsSnapshot(this.ctx.cwd);
		let problems: string[] = [];
		if (row.kind === "commands") {
			const ownRoots = new Set(commandRoutes(this.core.loadedCommands).map(route => route.path.split(" ")[0]!));
			let occupied: string[] = [];
			try { occupied = this.core.pi.getCommands().filter(command => !ownRoots.has(command.name)).map(command => command.name); } catch { /* Not every embedding has command introspection. */ }
			problems = commandProblems({ [row.path[1]!]: value } as GoalSettings["commands"], occupied).filter(problem => problem.includes("belongs to") || problem.includes("reserved"));
		} else if (row.kind === "keys") {
			// Goal-to-goal conflicts are checked against fresh layers under the write lock.
			const keys = bindingKeys(value as GoalKeybinding);
			try {
				const bindings = this.keymap.getResolvedBindings();
				// Modal/tree-only bindings never compete with the main goal controls.
				const main = Object.entries(bindings).filter(([id]) => /^(app\.(interrupt$|clear$|exit$|suspend$|thinking\.(cycle|toggle)$|model\.|tools\.|message\.|clipboard\.|editor\.|session\.(new|tree|fork|resume)$)|tui\.(editor|input)\.)/.test(id));
				for (const key of keys) {
					if (key === "escape" && (row.path[1] === "pause" || row.path[1] === "interruptAudit" || row.path[2] === "collapse")) continue;
					const conflict = main.find(([, binding]) => bindingKeys(binding).some(bound => sameGoalKey(bound, key, isKittyProtocolActive())));
					if (conflict && row.action?.context !== "expanded" && row.action?.context !== "audit" && row.action?.context !== "dialog") problems.push(`${formatGoalKeybinding(key)} is used by Pi (${conflict[0]}). Choose a free key or change it in Pi's keybindings.json.`);
				}
			} catch { /* Embeddings may omit keymap inspection. */ }
		}
		if (problems.length) { this.error = problems[0]!; return; }
		this.mutate({ op: "set", path: row.path, value });
	}
	private saveInput(): void {
		const row = this.row!;
		const text = this.editor.getValue().trim();
		if (!text) { this.error = "Enter a value, or use Disable to leave this action unbound."; return; }
		const parts = text.split(",").map(part => part.trim());
		if (row.kind === "commands") {
			const routes = parseCommandPaths(parts);
			if (!routes) { this.error = "Use command words such as /goal edit. Separate aliases with commas."; return; }
			this.save(this.adding ? [...new Set([...(this.setting(row) as string[]), ...routes])] : routes);
		} else {
			let keys = parseGoalKeybinding(text) ?? parseGoalKeybinding(parts);
			if (text.startsWith("[")) { try { keys = parseGoalKeybinding(JSON.parse(text)); } catch { keys = undefined; } }
			if (!keys) { this.error = "Use Pi key names such as ctrl+alt+p or f6, separated by commas."; return; }
			this.save(bindingKeys(keys));
		}
	}
	private selectOption(): void {
		const option = this.options()[this.actionIndex];
		const row = this.row!;
		this.error = "";
		if (option === "Back") { this.view = "list"; return; }
		if (row.kind === "reset") { this.mutate({ op: "unset", path: row.path }); return; }
		if (option === this.inheritLabel()) { this.mutate({ op: "unset", path: row.path }); return; }
		if (row.kind === "order") { this.save(PAUSE_ORDERS[this.actionIndex]!.id); return; }
		if (option === "Disable" || option === "Recovery entry only") { this.save([]); return; }
		if (option === "Use default") { this.save(row.defaults); return; }
		this.adding = option === "Add an alias" || option === "Record another key";
		if (option?.startsWith("Record")) { this.view = "capture"; return; }
		this.editor = new Input();
		this.editor.onSubmit = () => this.saveInput();
		this.editor.onEscape = () => { this.view = "actions"; this.error = ""; };
		// Input.setValue preserves the old cursor position. Inserting fresh text
		// starts editing at the end and gives each field its own undo history.
		const keys = row.kind === "keys" ? bindingKeys(this.setting(row) as GoalKeybinding) : [];
		const initial = this.adding ? "" : row.kind === "commands" ? (this.setting(row) as string[]).map(route => `/${route}`).join(", ") : keys.some(key => key.includes(",")) ? JSON.stringify(keys) : keys.join(", ");
		if (initial) this.editor.handleInput(initial);
		this.view = "input";
	}
	private match(data: string, action: "up" | "down" | "confirm" | "cancel"): boolean {
		try { if (this.keymap.matches(data, `tui.select.${action}`)) return true; } catch { /* Legacy Pi selection IDs. */ }
		return matchesKey(data, ({ up: "up", down: "down", confirm: "enter", cancel: "escape" } as const)[action]);
	}
	handleInput(data: string): void {
		if (this.closed || (data.startsWith("\x1b[") && /^[0-9:;]*:[23][u~ABCDHF]$/.test(data.slice(2)))) return;
		if (this.view === "list") this.selection[this.tabIndex] = Math.max(0, Math.min(this.selection[this.tabIndex]!, this.rows().length - 1));
		if (this.view === "input") { this.editor.handleInput(data); this.tui.requestRender(); return; }
		if (this.view === "capture") {
			if (this.match(data, "cancel")) { this.view = "actions"; this.error = ""; }
			else {
				const key = normalizeGoalKey(parseKey(data));
				if (key) { this.recorded = key; this.view = "key-preview"; this.error = ""; }
				else this.error = "Pi could not identify that key. Try Edit key names instead.";
			}
		} else if (this.view === "key-preview") {
			if (this.match(data, "cancel")) { this.view = "actions"; this.error = ""; }
			else if (this.match(data, "confirm")) this.save(this.adding ? [...new Set([...bindingKeys(this.setting(this.row!) as GoalKeybinding), this.recorded!])] : [this.recorded!]);
		} else if (this.view === "actions") {
			if (this.match(data, "cancel")) { this.view = "list"; this.error = ""; }
			else if (this.match(data, "up")) { this.actionIndex = Math.max(0, this.actionIndex - 1); this.error = ""; }
			else if (this.match(data, "down")) { this.actionIndex = Math.min(this.options().length - 1, this.actionIndex + 1); this.error = ""; }
			else if (this.match(data, "confirm")) this.selectOption();
		} else if (this.match(data, "cancel")) {
			if (this.query.getValue()) { this.query.setValue(""); this.selection[this.tabIndex] = 0; }
			else { this.closed = true; this.done(undefined); }
		} else if (matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			this.tabIndex = (this.tabIndex + (matchesKey(data, "left") || matchesKey(data, "shift+tab") ? 2 : 1)) % 3;
			this.query.setValue(""); this.notice = ""; this.error = "";
		} else if (matchesKey(data, "ctrl+s")) { this.scope = this.scope === "project" ? "global" : "project"; this.notice = ""; this.error = ""; this.snapshot = loadSettingsSnapshot(this.ctx.cwd); }
		else if (matchesKey(data, "ctrl+r") && this.pending()) {
			if (!this.ctx.isIdle()) this.error = "Commands are saved. Stop the current turn before applying them with /reload.";
			else if (!("reload" in this.ctx)) this.error = "Commands are saved. Close controls and run /reload to apply them.";
			else { this.closed = true; this.done("reload"); }
		} else if (this.match(data, "up") || this.match(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown") || matchesKey(data, "home") || matchesKey(data, "end")) {
			const change = matchesKey(data, "home") ? -Infinity : matchesKey(data, "end") ? Infinity : matchesKey(data, "pageUp") ? -this.pageSize : matchesKey(data, "pageDown") ? this.pageSize : this.match(data, "up") ? -1 : 1;
			this.selection[this.tabIndex] = Math.max(0, Math.min(this.rows().length - 1, this.selection[this.tabIndex]! + change));
			this.error = ""; this.notice = "";
		}
		else if (this.match(data, "confirm")) {
			this.row = this.rows()[this.selection[this.tabIndex]!];
			if (this.row) { this.view = "actions"; this.actionIndex = this.row.kind === "order" ? Math.max(0, PAUSE_ORDERS.findIndex(order => order.id === this.setting(this.row!))) : 0; this.notice = ""; this.error = ""; }
		} else { this.query.handleInput(data); this.selection[this.tabIndex] = 0; this.error = ""; this.notice = ""; }
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const inner = Math.max(10, Math.min(width - 2, 100));
		const height = Math.max(12, Math.min(25, (this.tui.terminal.rows || 32) - 7));
		const dim = (text: string) => this.theme.fg("dim", text);
		const accent = (text: string) => this.theme.fg("accent", text);
		const fit = (text: string) => truncateToWidth(text, inner - 2, "…");
		const lines: string[] = [this.theme.bold("Goal controls") + dim(`  · ${this.scope === "project" ? "This project" : "All projects"}`),
			TABS.map((tab, i) => i === this.tabIndex ? accent(this.theme.bold(`[${tab}]`)) : dim(` ${tab} `)).join("  ")];
		const help: string[] = [];
		let source = "";
		const footer = this.view === "list" ? [inner < 50 ? "↑↓/PgUp/PgDn move · Enter edit" : "↑↓/PgUp/PgDn move · Home/End ends · Enter edit", "Tab tabs · Ctrl+S scope · Esc back",
			...(this.pending() ? ["reload" in this.ctx ? "Ctrl+R apply saved commands when idle" : "/reload applies command changes"] : [])]
			: [(this.view === "input" || this.view === "key-preview") ? "Enter save · Esc cancel" : this.view === "capture" ? "Press a key · Esc cancel" : "↑↓ move · Enter select · Esc back"];
		const messageLines = (message: string, list: boolean) => wrapTextWithAnsi(message, inner - 2).slice(0, Math.max(1, Math.min(3, height - footer.length - (list ? 8 : 9))));
		if (this.view === "list") {
			const rows = this.rows();
			const selected = Math.max(0, Math.min(this.selection[this.tabIndex]!, rows.length - 1));
			this.selection[this.tabIndex] = selected;
			lines.push(dim(`Search: ${this.query.getValue() || "type to filter"}`));
			const row = rows[selected];
			if (row) help.push(row.kind === "order" ? PAUSE_ORDERS.find(order => order.id === this.setting(row))!.help : row.help);
			if (this.tab === "Pausing") help.push(`Pause key: ${formatGoalKeybinding(this.snapshot.value.keybindings?.pause ?? "escape")}. ${this.core.interruption.isHeld() ? "Turn is stopped; waiting for you." : ""}`);
			const capacity = Math.max(1, height - 8 - footer.length - messageLines(this.error || [this.notice, ...help].filter(Boolean).join(" "), true).length);
			this.pageSize = capacity;
			const start = Math.max(0, Math.min(selected - Math.floor(capacity / 2), rows.length - capacity));
			const labelWidth = Math.min(39, Math.max(15, Math.floor(inner * .48)));
			for (const [index, row] of rows.slice(start, start + capacity).entries()) {
				const active = start + index === selected;
				const label = truncateToWidth(row.label, labelWidth, "…");
				const value = this.display(row, this.setting(row));
				const content = row.kind === "reset" ? `${active ? "›" : " "} ${row.label}` : `${active ? "›" : " "} ${label}${" ".repeat(Math.max(1, labelWidth - visibleWidth(label) + 1))}${value}`;
				lines.push(active ? accent(fit(content)) : fit(content));
			}
			if (!rows.length) lines.push(dim("No matching controls."));
			while (lines.length < 3 + capacity) lines.push("");
			const origin = row ? ({ project: "This project", global: "All projects", default: "Default" }[this.source(row)] ?? "") : "";
			source = rows.length ? `${selected + 1}/${rows.length}${origin ? ` · Source: ${origin}` : ""}${this.scope === "global" && row && valueAtPath(this.snapshot.project.layer, row.path) !== undefined ? " · overridden here" : ""}` : "";
		} else {
			lines.push(accent(this.theme.bold(this.row!.label)));
			help.push(this.row!.help);
			if (this.view === "actions") {
				lines.push(dim(`${this.actionIndex + 1}/${this.options().length} · Current: ${this.display(this.row!, this.setting(this.row!))}`));
				this.options().forEach((option, i) => lines.push(i === this.actionIndex ? accent(`› ${option}`) : `  ${option}`));
				help.splice(0, help.length, this.optionHelp());
			} else if (this.view === "input") {
				lines.push(dim(this.row!.kind === "commands" ? "Command paths, separated by commas:" : "Pi key names, separated by commas:"));
				lines.push(...this.editor.render(inner - 2));
				help.unshift(this.row!.kind === "commands" ? "First path is preferred; additional paths are aliases. Example: /goal-tweak, /goal edit." : this.editor.getValue().startsWith("[") ? 'JSON key list keeps comma keys intact. Example: ["ctrl+,", "f6"].' : "Example: ctrl+alt+p, f6. Use Disable to leave this action unbound.");
			} else if (this.view === "capture") {
				lines.push("", accent("Press the key you want to use…"));
				help.unshift("Esc cancels. To bind Escape, use Edit key names.");
			} else {
				lines.push("", accent(this.theme.bold(formatGoalKeybinding(this.recorded))), "", "Enter to save · Esc to cancel");
			}
		}
		const message = this.error || [this.notice, ...help].filter(Boolean).join(" ");
		const wrapped = messageLines(message, this.view === "list");
		// Keep the selected action, validation message and navigation visible.
		const bodyLimit = height - wrapped.length - footer.length - 3 - (this.view === "list" ? 1 : 0);
		if (lines.length > bodyLimit) {
			if (this.view === "actions") {
				const head = lines.slice(0, Math.min(4, bodyLimit - 1));
				const capacity = Math.max(1, bodyLimit - head.length);
				const start = Math.max(4, 4 + this.actionIndex - capacity + 1);
				lines.splice(0, lines.length, ...head, ...lines.slice(start, start + capacity));
			} else lines.splice(bodyLimit);
		}
		if (this.view === "list") lines.push(dim(source));
		lines.push(dim("─".repeat(inner - 2)), ...wrapped.map(line => this.error ? this.theme.fg("error", line) : dim(line)), ...footer.map(dim));
		const border = (text: string) => accent("│") + " " + fit(text) + " ".repeat(Math.max(0, inner - 1 - visibleWidth(fit(text)))) + accent("│");
		return [accent(`┌${"─".repeat(inner)}┐`), ...lines.map(border), accent(`└${"─".repeat(inner)}┘`)];
	}
}

export async function showGoalControls(core: GoalCore, ctx: ExtensionContext, scope: SettingsScope = "project"): Promise<boolean> {
	if (!ctx.hasUI) { ctx.ui.notify("Open /goal-settings controls in an interactive Pi session to customize controls.", "info"); return false; }
	core.enterGoalModal();
	let reload: "reload" | undefined;
	try { reload = await ctx.ui.custom((tui, theme, keymap, done) => new GoalControlsDialog(core, ctx, tui, theme, keymap, done, scope)); }
	finally { core.exitGoalModal(); }
	if (reload && "reload" in ctx) { await (ctx as ExtensionContext & { reload(): Promise<void> }).reload(); return true; }
	return false;
}
