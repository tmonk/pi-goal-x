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
export const SET_GOAL_TASKS_TOOL_NAME = "set_goal_tasks";
export const UPDATE_GOAL_TASK_TOOL_NAME = "update_goal_task";

/** The stable core model surface: three tools, installed without phase-dependent sync. */
export const CORE_GOAL_TOOL_NAMES = [CREATE_GOAL_TOOL_NAME, GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME] as const;

/** The two consolidated task tools advertised when tasks are enabled (Stage 4). */
export const TASK_TOOL_NAMES = [SET_GOAL_TASKS_TOOL_NAME, UPDATE_GOAL_TASK_TOOL_NAME] as const;

/** Fixed task-enabled profile: all five registered goal tools. */
export const FIVE_GOAL_TOOLS = [...CORE_GOAL_TOOL_NAMES, ...TASK_TOOL_NAMES] as const;

/** Fixed task-disabled profile: the three core tools. */
export const CORE_GOAL_TOOLS = CORE_GOAL_TOOL_NAMES;

/** Every goal tool this extension registers (used by installGoalToolProfile). */
export const ALL_REGISTERED_GOAL_TOOLS = [...FIVE_GOAL_TOOLS] as const;

/** Legacy task tools kept only as non-advertised compatibility shims until Stage 7. */
export const LEGACY_TASK_TOOL_NAMES = [PROPOSE_TASK_LIST_TOOL_NAME, COMPLETE_TASK_TOOL_NAME, SKIP_TASK_TOOL_NAME] as const;

export const ACTIVE_GOAL_TOOL_NAMES = [...CORE_GOAL_TOOL_NAMES, ...TASK_TOOL_NAMES] as const;
export const PAUSED_GOAL_TOOL_NAMES = [...CORE_GOAL_TOOL_NAMES, SET_GOAL_TASKS_TOOL_NAME] as const;
export const NO_FOCUSED_GOAL_TOOL_NAMES = [GET_GOAL_TOOL_NAME, CREATE_GOAL_TOOL_NAME] as const;

export const GOAL_WORK_TOOL_NAMES = [
	UPDATE_GOAL_TOOL_NAME,
	SET_GOAL_TASKS_TOOL_NAME,
	UPDATE_GOAL_TASK_TOOL_NAME,
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
	UPDATE_GOAL_TASK_TOOL_NAME,
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
