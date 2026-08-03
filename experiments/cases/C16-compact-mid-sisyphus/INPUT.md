# C16 — compaction-then-resume mid sisyphus (B3)

## Behavior under test

While a 5-step sisyphus run is in progress, automatic compaction triggers (compaction.json enabled, threshold=4000). Verify the `postCompactReminderPending` mechanism added in Phase 4:
- after compaction, the next agent_start injects a "POST-COMPACTION RESYNC" block informing the authoritative step counter
- the agent continues and completes the remaining steps (does not fail due to compaction summary drift)
- finally all 5 steps complete + complete_goal

## Prompts

TURN: /goal-sisyphus "Sisyphus 5 steps: 1) create f1.txt with 'one'. 2) create f2.txt with 'two'. 3) create f3.txt with 'three'. 4) create f4.txt with 'four'. 5) create f5.txt with 'five'. Each step_complete pass verifyCommand like test -f f1.txt && [ \"$(cat f1.txt)\" = one ]. autoContinue: true."
