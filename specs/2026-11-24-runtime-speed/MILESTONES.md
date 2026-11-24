# Milestones

## 2026-11-24

- Measured first. The only hook that grew with the session was the history
  check in `LiveTailRetention` (1.4 s of the 2.8 s B11 profile was
  `JSON.stringify` and SHA-256 over every message, every request).
- First try at the history check: one-shot `crypto.hash` instead of
  `createHash`. Gain was about 5%, not worth keeping on its own.
- Second try, kept: compare each request with a snapshot of the last one.
  Raw strings up to 1,024 characters left half the time in hashing the 2.8 KB
  tool results, so the limit went to 4,096. Late turns went from 32 ms to 7 ms (1,920 messages, 2.8 MiB).
- Found that `agent_end` saved a goal that the turn-end flush had just saved.
  Skipping by object identity did not work: reconcile replaces the focused goal
  with the disk copy after every write. Comparing saved content did.
- Tried lazy-loading `goal-completion` and the questionnaire. 24 tests failed
  because the auditor and the proposal dialog no longer start in the same tick
  as the tool call. Reverted both; kept the command-only modules.
- Prompt cache: nothing to change. The gate, the simulator and the new
  stability tests all agree with 0.35.1.
- Not done: see TECH.md, "Left alone, and why".
