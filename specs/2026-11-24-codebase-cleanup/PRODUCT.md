# Codebase cleanup

## Goal

Make pi-goal-x easier to read, change and review without changing what users
see. After this work a contributor can find a behavior from the module list,
trust that every exported function is used by the shipped extension, and add a
test without copying a fake Pi host.

## User-visible behavior

None, with one exception: the developer-only `PI_GOAL_DEBUG` keybindings
(Ctrl+Shift+X/N/T/R/O, the debug panel and the mock audit) are removed. They
were undocumented, unreachable without an environment variable, and one of them
only printed a notice saying the dialog it once opened no longer exists.

## Non-goals

- Fixing open issues or adopting open pull requests. That is planned
  separately in `specs/2026-11-24-issue-and-pr-resolution/`.
- Splitting the largest modules (`goal-settings.ts`, `goal-state.ts`,
  `goal-questionnaire.ts`, `goal-ledger.ts`). See TECH.md, "Deferred".
- Changing prompts, tool schemas, persisted formats or settings.
