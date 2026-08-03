# C18 — abort/Ctrl-C mid-turn (B4)

## Behavior under test

drive.mjs calls `session.abort()` 20 seconds after the first TURN is sent (ABORT_AFTER_MS below), simulating a user Ctrl-C interrupting the sisyphus chain. Verify the `pauseForAbort` path added in Phase 4:
- `turn_end` / `message_end` detects `isAbortedAssistantMessage` (`stopReason === "aborted"`)
- → `pauseActiveGoal(ctx)` → goal.status = "paused", stopReason = "user", autoContinue = false

/goal-sisyphus triggers drafting → the agent immediately proposes with propose_goal_draft → goal created → autoContinue starts → abort fires → pause.

Final: the goal on disk is in paused state. autoContinue should stop (its value false).

## Prompts

ABORT_AFTER_MS: 20000
TURN: /goal-sisyphus "Sisyphus: precisely 5 sequential steps, each requires `bash sleep 4` BEFORE the write. 1) sleep 4 + write a.txt='a'. 2) sleep 4 + write b.txt='b'. 3) sleep 4 + write c.txt='c'. 4) sleep 4 + write d.txt='d'. 5) sleep 4 + write e.txt='e'. autoContinue: true. The sleep is part of the done-when criterion; do not skip. If asked, propose this exact spec via propose_goal_draft immediately without further clarification."
