export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const GET_GOAL_TOOL_NAME = "get_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";
export const SET_GOAL_TASKS_TOOL_NAME = "set_goal_tasks";
export const UPDATE_GOAL_TASK_TOOL_NAME = "update_goal_task";

/** The stable core model surface: three tools, installed without phase-dependent sync. */
export const CORE_GOAL_TOOL_NAMES = [CREATE_GOAL_TOOL_NAME, GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME] as const;

/** The two consolidated task tools advertised when tasks are enabled. */
export const TASK_TOOL_NAMES = [SET_GOAL_TASKS_TOOL_NAME, UPDATE_GOAL_TASK_TOOL_NAME] as const;

/** Fixed task-enabled profile: all five registered goal tools. */
export const FIVE_GOAL_TOOLS = [...CORE_GOAL_TOOL_NAMES, ...TASK_TOOL_NAMES] as const;

/** Fixed task-disabled profile: the three core tools. */
export const CORE_GOAL_TOOLS = CORE_GOAL_TOOL_NAMES;

/** Every goal tool this extension registers (used by installGoalToolProfile). */
export const ALL_REGISTERED_GOAL_TOOLS = [...FIVE_GOAL_TOOLS] as const;

/**
 * Goal tools that count as "real work" toward the active goal plus the common
 * host work tools. Used by the empty-turn continuation gate: if a non-tool-use
 * turn ends without any of these having been called, we do NOT queue the next
 * autoContinue.
 */
export const GOAL_WORK_TOOL_NAMES = [
	UPDATE_GOAL_TOOL_NAME,
	SET_GOAL_TASKS_TOOL_NAME,
	UPDATE_GOAL_TASK_TOOL_NAME,
	CREATE_GOAL_TOOL_NAME,
	GET_GOAL_TOOL_NAME,
	"write",
	"edit",
	"bash",
	"read",
	"grep",
	"find",
	"ls",
] as const;

/**
 * The subset of GOAL_WORK_TOOL_NAMES that indicates actual progress (excludes
 * read-only surface tools such as get_goal and create_goal).
 */
export const GOAL_PROGRESS_TOOL_NAMES = [
	UPDATE_GOAL_TOOL_NAME,
	UPDATE_GOAL_TASK_TOOL_NAME,
	"write",
	"edit",
	"bash",
	"read",
	"grep",
	"find",
	"ls",
] as const;

/** Tools the model may still call on a stopped turn (state reads only). */
export const POST_STOP_ALLOWED_TOOLS = ["get_goal"] as const;
