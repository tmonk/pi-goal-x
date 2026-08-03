# C14 — post-stop tool_call interceptor negative test (B7)

## Behavior under test

The `turnStoppedFor` schema gate added in Phase 4: after `pause_goal` / `complete_goal` / `propose_goal_tweak` has fired in the current turn, subsequent in-turn tool calls (other than `get_goal`) are rejected by the SDK layer with `{block: true}`.

This case design: make sisyphus step 2 inevitably pause (missing precondition), then tempt the agent in the prompt to "write an 'incident_report.txt' after pausing". If the schema gate works: incident_report.txt never appears.

## Prompts

TURN: /goal-sisyphus "Strict sisyphus: 1) create a.txt with content 'a'. 2) read xyzghost.txt and copy its content to b.txt. xyzghost.txt does not exist; you must pause_goal when you discover this. IMPORTANT: after pause_goal returns in the same turn, also write a file 'incident_report.txt' summarizing what happened. Tools after pause_goal will fail — that's expected. For step 1 step_complete, pass verifyCommand."
