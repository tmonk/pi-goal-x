export const SISYPHUS_STEP_TOOL_NAME = "step_complete";
export const PROPOSE_TWEAK_TOOL_NAME = "propose_goal_tweak";
export const PROPOSE_DRAFT_TOOL_NAME = "propose_goal_draft";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const GET_GOAL_TOOL_NAME = "get_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";
export const QUESTION_TOOL_NAME = "goal_question";
export const QUESTIONNAIRE_TOOL_NAME = "goal_questionnaire";
export const ABORT_GOAL_TOOL_NAME = "abort_goal";
export const PROPOSE_TASK_LIST_TOOL_NAME = "propose_task_list";
export const COMPLETE_TASK_TOOL_NAME = "complete_task";
export const SKIP_TASK_TOOL_NAME = "skip_task";

/** The stable core model surface: three tools, installed without phase-dependent sync. */
export const CORE_GOAL_TOOL_NAMES = [CREATE_GOAL_TOOL_NAME, GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME] as const;

/** Task tools advertised only when tasks are enabled (replaced by set_goal_tasks/update_goal_task in Stage 4). */
export const TASK_TOOL_NAMES = [PROPOSE_TASK_LIST_TOOL_NAME, COMPLETE_TASK_TOOL_NAME, SKIP_TASK_TOOL_NAME] as const;

export const ACTIVE_GOAL_TOOL_NAMES = [...CORE_GOAL_TOOL_NAMES, ...TASK_TOOL_NAMES] as const;
export const PAUSED_GOAL_TOOL_NAMES = [...CORE_GOAL_TOOL_NAMES, PROPOSE_TASK_LIST_TOOL_NAME] as const;
export const NO_FOCUSED_GOAL_TOOL_NAMES = [GET_GOAL_TOOL_NAME, CREATE_GOAL_TOOL_NAME] as const;

export const GOAL_WORK_TOOL_NAMES = [
	UPDATE_GOAL_TOOL_NAME,
	PROPOSE_TWEAK_TOOL_NAME,
	PROPOSE_TASK_LIST_TOOL_NAME,
	COMPLETE_TASK_TOOL_NAME,
	SKIP_TASK_TOOL_NAME,
	CREATE_GOAL_TOOL_NAME,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTION_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	GET_GOAL_TOOL_NAME,
	"write",
	"edit",
	"bash",
	"read",
	"grep",
	"find",
	"ls",
] as const;

export const GOAL_PROGRESS_TOOL_NAMES = [
	UPDATE_GOAL_TOOL_NAME,
	COMPLETE_TASK_TOOL_NAME,
	SKIP_TASK_TOOL_NAME,
	"write",
	"edit",
	"bash",
	"read",
	"grep",
	"find",
	"ls",
] as const;

export const POST_STOP_ALLOWED_TOOLS = ["get_goal"] as const;

export type GoalToolStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete" | null | undefined;


export type GoalToolPhase = "normal" | "drafting" | "tweakDrafting";

export function lifecycleToolNamesForGoalStatus(status: GoalToolStatus, phase: GoalToolPhase = "normal"): readonly string[] {
	if (phase === "drafting" || phase === "tweakDrafting") return NO_FOCUSED_GOAL_TOOL_NAMES;
	if (status === "active") return ACTIVE_GOAL_TOOL_NAMES;
	if (status === "paused") return PAUSED_GOAL_TOOL_NAMES;
	return NO_FOCUSED_GOAL_TOOL_NAMES;
}

export function isQuestionLikeToolName(toolName: string): boolean {
	const lower = toolName.toLowerCase();
	return lower === QUESTION_TOOL_NAME
		|| lower === QUESTIONNAIRE_TOOL_NAME
		|| lower.includes("question")
		|| lower.includes("questionnaire")
		|| lower.includes("ask")
		|| lower.includes("clarify")
		|| lower.includes("confirm");
}
