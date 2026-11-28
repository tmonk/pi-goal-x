# Milestones

- Drove a real SDK session against a fake provider through create, work, pause, resume, wait cycles, settings changes, completion and a second goal. Compared each request with the one before it.
- Found one real break: when the goal completed, the context hook cleared the retained blocks, so the next request lost everything after the first block. Pause, resume, waits, task updates and settings changes were already stable.
- Fix: `LiveTailRetention.retire` keeps the blocks and appends an ended or on-hold block. Stale and unfocused text is an interim state with no scope of its own, so the goal after it needs no reset.
- Also fixed while auditing: a non-copyable message gave a null snapshot that matched nothing and reset every request; a host with no session id retained nothing; the session map evicted by age, not use.
- Could not reproduce a constant miss on every request in 0.35.3 on Pi 1.4.0 or 1.7.0. Asked the reporter for the Pi version, provider and the `/goal-status verbose` cache line.
- Tests: `tests/goal-cache-lifecycle.test.ts` and the real SDK run in `tests/e2e/goal-prefix-lifecycle-sdk.test.ts`. The SDK run fails on the code before the fix.
