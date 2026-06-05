export const SISYPHUS_STEP_TOOL_NAME = "step_complete";
export const PROPOSE_TWEAK_TOOL_NAME = "propose_goal_tweak";
export const PROPOSE_DRAFT_TOOL_NAME = "propose_goal_draft";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const QUESTION_TOOL_NAME = "goal_question";
export const QUESTIONNAIRE_TOOL_NAME = "goal_questionnaire";
export const ABORT_GOAL_TOOL_NAME = "abort_goal";
export const PROPOSE_TASK_LIST_TOOL_NAME = "propose_task_list";
export const COMPLETE_TASK_TOOL_NAME = "complete_task";
export const SKIP_TASK_TOOL_NAME = "skip_task";

export const ACTIVE_GOAL_TOOL_NAMES = ["get_goal", "complete_goal", "pause_goal", ABORT_GOAL_TOOL_NAME, PROPOSE_TWEAK_TOOL_NAME, PROPOSE_TASK_LIST_TOOL_NAME, COMPLETE_TASK_TOOL_NAME, SKIP_TASK_TOOL_NAME] as const;
export const PAUSED_GOAL_TOOL_NAMES = ["get_goal", "complete_goal", ABORT_GOAL_TOOL_NAME, PROPOSE_TWEAK_TOOL_NAME, PROPOSE_TASK_LIST_TOOL_NAME] as const;
export const NO_FOCUSED_GOAL_TOOL_NAMES = ["get_goal"] as const;

export const GOAL_WORK_TOOL_NAMES = [
	"complete_goal",
	"pause_goal",
	ABORT_GOAL_TOOL_NAME,
	PROPOSE_TWEAK_TOOL_NAME,
	PROPOSE_TASK_LIST_TOOL_NAME,
	COMPLETE_TASK_TOOL_NAME,
	SKIP_TASK_TOOL_NAME,
	CREATE_GOAL_TOOL_NAME,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTION_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	"get_goal",
	"write",
	"edit",
	"bash",
	"read",
	"grep",
	"find",
	"ls",
] as const;

export const GOAL_PROGRESS_TOOL_NAMES = [
	"complete_goal",
	"pause_goal",
	ABORT_GOAL_TOOL_NAME,
	COMPLETE_TASK_TOOL_NAME,
	SKIP_TASK_TOOL_NAME,
	"write",
	"edit",
	"bash",
	"read",
	"grep",
	"find",
	"ls",
	"subagent",
	"Agent",
	"get_subagent_result",
	"steer_subagent",
] as const;

export const POST_STOP_ALLOWED_TOOLS = ["get_goal"] as const;

export type GoalToolStatus = "active" | "paused" | "complete" | null | undefined;


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
