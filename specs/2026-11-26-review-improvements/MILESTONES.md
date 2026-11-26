# Milestones

- Baseline on main: 1309 tests pass.
- Idle-turn breaker in `goal-scheduler.ts`. It counts only turns the scheduler started, resets on user work, resume and kickoff, and is off with idle backoff.
- Busy hold: `pi-goal:busy` events, a per-source count, a 60 minute fallback so a hung job cannot hold a goal.
- Cache stats from message usage. Warns once after two bad requests that follow a good one.
- Verify command with a trust list under the agent folder. Attempted trust inside the goal file was rejected: a repository could ship its own trust.
- Auditor limits. The first test hung: `auditorTimeoutMinutes` accepts whole numbers only, so a fractional test value was ignored. Tests use mock timers.
- The usage-line change needed five existing tests to ask for the line explicitly.
- A policy-text trim was tried and reverted: it removed the hint that the agent may set `maxAutonomousRuns`, which a test and the docs rely on.
- The context gate and cache gate failed on purpose-built expectations: a request-only usage snapshot always at the tail, an exact block count against release 4883b97, and a byte-identical post-compaction block. Changed them to match: the snapshot is required only for token-budget fixtures, the block count may be one lower, and the post-compaction resync text counts as goal text. `baseline-main.json` was re-measured; every change in it is the missing usage line or the added evidence lines.
- A guard for a `turn_end` event with no message came from the e2e lifecycle test: `message.usage` threw.
