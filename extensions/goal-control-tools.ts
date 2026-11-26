/**
 * goal_control — the two goal lifecycle actions an agent may ask for.
 *
 * Neither was reachable from a tool call: `/goal-tweak` and `/goal-clear` are
 * user commands, and the only alternatives left to an agent were editing goal
 * files (never allowed) or creating a replacement goal (wrong: it drops the
 * plan, the progress and the usage). This tool opens the same confirmation
 * dialogs those commands use, so one confirmation still decides and nothing is
 * written before it.
 *
 * `revise` reuses the drafting proposal path (`prepareProposal` /
 * `applyProposal`): it starts a tweak draft, shows the tweak confirmation, and
 * on confirm revises the SAME goal. It never creates a replacement goal.
 * `archive` shows the clear confirmation and files the goal out of the active
 * pool.
 *
 * Both refuse when the host cannot show a dialog, because a silent objective
 * rewrite or archive is exactly what this must not become. The documented
 * PI_GOAL_AUTO_CONFIRM=1 opt-in still applies to `revise`, like the drafting
 * tools.
 */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { commandHint, commandInstructions } from "./goal-controls.ts";
import { activeDraft, setActiveDraft, type ActiveGoalDraft } from "./goal-drafting.ts";
import { applyProposal, prepareProposal, type DraftingToolsCore, type ProposalInput } from "./goal-drafting-tools.ts";
import { goalTextResult, oneLineSummary, renderGoalResult } from "./goal-format.ts";
import { clearGoalCommandMessage } from "./goal-policy.ts";
import { DIALOG_UNAVAILABLE_HINT } from "./goal-questionnaire.ts";
import { nowIso, type GoalRecord } from "./goal-record.ts";
import { CONTROL_GOAL_TOOL_NAME } from "./goal-tool-names.ts";
import { loadGoalSettings } from "./settings/resolve.ts";
import { t } from "./i18n/index.ts";
import type {
	FocusSlice,
	GoalDiskSync,
	GoalFocusedGoalAccess,
	GoalOperationGuard,
	LifecycleSlice,
} from "./goal-core-types.ts";

/** What the clear flow reads and changes; also satisfied by the command core. */
export type ArchiveGoalCore = GoalDiskSync &
	GoalFocusedGoalAccess &
	GoalOperationGuard &
	FocusSlice<"setGoal"> &
	LifecycleSlice<"archive">;

/** What the control tool reads and changes. */
type ControlToolsCore = DraftingToolsCore &
	GoalOperationGuard &
	FocusSlice<"setGoal"> &
	LifecycleSlice<"archive">;

export type ArchiveOutcome =
	| { status: "archived"; goal: GoalRecord }
	| { status: "cancelled" | "changed" | "failed" | "no-ui" | "none" };

/**
 * Ask the existing clear confirmation and archive the focused goal. The single
 * implementation behind `/goal-clear` and `goal_control({action:"archive"})`:
 * confirm, re-validate the focus token, archive, unfocus. Nothing is written
 * when the user cancels or the goal moved while the dialog was open.
 */
export async function archiveFocusedGoal(core: ArchiveGoalCore, ctx: ExtensionContext): Promise<ArchiveOutcome> {
	core.reconcileFocusedGoalFromDisk(ctx);
	const target = core.state.goal;
	if (!target) return { status: "none" };
	// Archiving needs the dialog: there is no headless shortcut for it.
	if (!ctx.hasUI) return { status: "no-ui" };
	const focusToken = core.state.focusToken(target.id);
	const confirmed = await ctx.ui.confirm(t("Clear goal?"), oneLineSummary(target));
	if (!confirmed) return { status: "cancelled" };
	core.reconcileFocusedGoalFromDisk(ctx);
	if (!core.state.isTokenCurrent(focusToken) || !core.state.goal || core.state.goal.id !== target.id) return { status: "changed" };
	const archived = core.lifecycle.archive(ctx, "user");
	core.focus.setGoal(null, ctx, true, "cleared");
	return archived ? { status: "archived", goal: archived } : { status: "failed" };
}

/** The revise path: a tweak draft plus the shared proposal confirmation. */
async function reviseFocusedGoal(core: ControlToolsCore, ctx: ExtensionContext, params: { change?: string; objective?: string; token_budget?: number | null }) {
	const reply = (text: string) => goalTextResult(text, core.state.goal);
	const change = params.change?.trim() ?? "";
	if (!change) return reply('goal_control({action:"revise"}) needs a "change" describing the requested revision, so the confirmation and the ledger say what changed.');
	if (activeDraft(core)) return reply(commandInstructions("A goal draft is in progress. Finish it, or ask the user to run /goal-cancel, before revising the goal.", core.loadedCommands));
	const input: ProposalInput = {
		objective: params.objective ?? core.state.goal?.objective ?? "",
		token_budget: params.token_budget,
		auto_continue: core.state.goal?.autoContinue,
	};
	// Validate before a draft exists, so a rejected revision leaves no draft.
	const prepared = prepareProposal(core, ctx, input);
	if (!prepared.ok) return reply(prepared.message);
	const target = core.state.goal;
	if (!target) return reply(`No goal is focused. Start one with ${commandHint("goal", core.loadedCommands)} or ${commandHint("goal-direct", core.loadedCommands)}.`);
	if (target.status === "complete") return reply("Completed goals cannot be revised. Start a new goal instead.");
	// The confirmation dialog is the point of this tool: no UI, no revision,
	// unless the documented benchmark opt-in is set explicitly.
	if (!ctx.hasUI && process.env.PI_GOAL_AUTO_CONFIRM !== "1") return reply(`${DIALOG_UNAVAILABLE_HINT} The goal was NOT revised.`);
	// Same per-goal auditor default the /goal-tweak draft uses.
	const draft: ActiveGoalDraft = {
		mode: "tweak",
		originalTopic: change,
		targetGoalId: target.id,
		startedAt: nowIso(),
		auditorEnabled: !(target.skipAuditor ?? loadGoalSettings(ctx.cwd).disabled),
	};
	setActiveDraft(core, draft);
	return applyProposal(core, ctx, draft, input, prepared.value);
}

function archiveResultText(outcome: ArchiveOutcome, core: ControlToolsCore): string {
	const summary = oneLineSummary(core.state.goal);
	switch (outcome.status) {
		case "archived": {
			const path = outcome.goal.archivedPath ? `\n${t("Archive: {path}", { path: outcome.goal.archivedPath })}` : "";
			return `${clearGoalCommandMessage({ archived: true })}${path}\n\nThe archived goal is no longer focused.`;
		}
		case "cancelled":
			return "Goal archive cancelled; the goal is unchanged.";
		case "changed":
			return "Goal changed while confirming; nothing was archived.";
		case "failed":
			return "The goal could not be archived; nothing was changed. Read the goal state with get_goal before retrying.";
		case "no-ui":
			return t("Run {command} in an interactive session to confirm clearing: {summary}", { command: commandHint("goal-clear", core.loadedCommands), summary });
		default:
			return clearGoalCommandMessage({ archived: false });
	}
}

export function registerControlTools(core: ControlToolsCore): void {
	core.pi.registerTool(defineTool({
		name: CONTROL_GOAL_TOOL_NAME,
		label: "Goal Control",
		description:
			"Revise or archive the focused goal. Both open the same confirmation dialog the /goal-tweak and /goal-clear commands use; nothing is written before the user confirms. " +
			"revise changes the objective and/or total token budget of the SAME goal (progress and usage kept; a paused or blocked goal can come back). " +
			"archive files the goal out of the active pool. Task plans change with set_goal_tasks.",
		parameters: Type.Object({
			action: StringEnum(["revise", "archive"] as const, { description: "revise opens the goal-tweak confirmation; archive opens the clear confirmation" }),
			change: Type.Optional(Type.String({ description: "revise: the requested revision in one line, shown in the confirmation and recorded in the ledger." })),
			objective: Type.Optional(Type.String({ description: "revise: the complete revised objective. Omit to keep the current one." })),
			token_budget: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description: "revise: total lifetime token budget. null removes it; omit to keep it." })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === "archive") {
				// archiveFocusedGoal redraws the UI when it unfocuses the goal.
				const outcome = await archiveFocusedGoal(core, ctx);
				return goalTextResult(archiveResultText(outcome, core), core.state.goal, outcome.status === "archived" ? true : undefined);
			}
			return reviseFocusedGoal(core, ctx, params);
		},
		renderCall(args, theme) {
			const action = typeof args?.action === "string" ? args.action : "revise";
			const detail = action === "revise" ? String(args?.change ?? "") : oneLineSummary(core.state.goal);
			return new Text(theme.fg("toolTitle", `${CONTROL_GOAL_TOOL_NAME} ${action} `) + theme.fg("muted", detail), 0, 0);
		},
		renderResult(result, _opts, theme) { return renderGoalResult(result, _opts, theme); },
	}));
}
