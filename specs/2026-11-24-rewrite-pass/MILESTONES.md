## 2026-11-24, third pass

- Plan written (TECH.md). Work split into separate PRs.

### Test hosts

- Moved the hand-rolled fake hosts in `goal-network-recovery`, `goal-stale-continuation-golden`, `goal-modal-escape`, `integration/extension` and `e2e/goal-lifecycle-dashboard` onto `tests/support/extension-harness.ts`. Assertions and test counts are unchanged (1258 before and after).
- The harness gained `terminalInput()` (the recorded `onTerminalInput` handler) and a `setWorkingVisible` stub. Callers that add helpers use `Object.assign(h, ...)`, not a spread, which would freeze the harness getters.
- Left as they were: `e2e/network-recovery-rpc.test.ts` and `e2e/run.ts` spawn the real `pi` process and build no host. Other suites with their own hosts (`goal-controls`, `goal-progress-features`, `goal-scheduler`, `goal-session-safety`, `goal-surface-baseline`, `goal-tool-visibility`) were outside this pass.
