# Review improvements

Source: the 26 Nov 2026 deep-dive review of the extension. Goal: stop wasted requests, measure the cache, and make completion cheaper and safer, without touching the cached prompt prefix.

## What changes for users

- A goal pauses after `maxIdleTurns` (default 4) automatic turns with no tool call.
- Other extensions can hold continuation with `pi-goal:busy` while their background jobs run.
- A confirmed `Verify command` in the contract runs before the auditor.
- Optional audit limits, off by default: `auditorTimeoutMinutes` and `auditorMaxToolCalls`.
- `/goal-status verbose` shows the provider's cache hit rate and a warning when it collapses.
- `maxGoalMinutes` limits a goal's active time. `draftStyle` can skip the interview.
- The usage line is sent only with a token budget or `showContextUsage`.
- Post-compaction text carries recent task evidence.

## Not done, and why

- Tool schema trim: the schemas are already tight. The only large part is the `continuation` union in `update_goal`, which strict-mode users need. Any cut means one cache reset for every user for about 100 tokens of cached text.
- Policy block trim: the line about `maxAutonomousRuns` tells the agent where to set the allowance, and a test pins it. Kept.
- Lazy tool registration: Pi allows late registration, but it resets the cache at the first `/goal` in a session and removes agent-initiated `create_goal`. Needs Tom's decision.
- Fewer settings and a smaller ledger: both break saved files or risk recovery for little gain. Needs Tom's decision.
- A separate notes field: would add a tool argument (a cache reset). Task evidence in the post-compaction text covers most of it.
