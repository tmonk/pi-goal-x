# C20 — Core tool selection: only the five goal tools, correct intent selection

## Behavior under test

The model sees exactly the five goal tools (create_goal, get_goal, update_goal,
set_goal_tasks, update_goal_task) plus normal work tools. When the user asks
for a persistent goal, the model must call `create_goal` directly — not
`propose_goal_draft`, not any removed tool. It must not call removed lifecycle
tools (complete_goal, pause_goal, abort_goal, step_complete, the legacy task
tools, goal_question, goal_questionnaire) under any circumstances.

Expected:
- `create_goal` is called with the concrete objective;
- the goal lands on disk and becomes the session focus;
- no removed tool name ever appears in the call stream.

## Prompts

TURN: /goal Create a new file called hello.txt containing "Hello" in the sandbox current directory. Do not modify any other files.
