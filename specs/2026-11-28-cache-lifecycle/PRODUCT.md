# Keep the prompt cache through the goal lifecycle

Issue #187 reported constant prompt-cache misses on 0.35.3 while a goal ran, and misses when goals start or stop.

## Behavior

- Every request must be a prefix of the next one, except its last request-only block.
- That holds through create, work, pause, resume, settings changes, completion and a second goal.
- When no goal is in force, the goal blocks already sent stay in the history. One short block says they no longer apply.
- A draft, a stale checkpoint and an unfocused pool are handled the same way. They do not drop the blocks.
- A goal that follows one of these starts without a reset.

## Still a reset on purpose

- One goal straight into another, or an edited objective, contract or sisyphus mode.
- History rewrites: compaction, session-tree moves, a reload.
- The size bounds.
- Turning `disableTasks` on or off (it changes the tool list).
