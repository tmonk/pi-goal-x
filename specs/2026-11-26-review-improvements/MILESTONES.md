# Milestones

- Baseline on main: 1309 tests pass.
- Idle-turn breaker in `goal-scheduler.ts`. It counts only turns the scheduler started, resets on user work, resume and kickoff, and is off with idle backoff.
- Busy hold: `pi-goal:busy` events, a per-source count, a 60 minute fallback so a hung job cannot hold a goal.
- Cache stats from message usage. Warns once after two bad requests that follow a good one.
- Verify command with a trust list under the agent folder. Attempted trust inside the goal file was rejected: a repository could ship its own trust.
- Auditor limits. The first test hung: `auditorTimeoutMinutes` accepts whole numbers only, so a fractional test value was ignored. Tests use mock timers.
- The usage-line change needed five existing tests to ask for the line explicitly.
- A policy-text trim was tried and reverted: it removed the hint that the agent may set `maxAutonomousRuns`, which a test and the docs rely on.
