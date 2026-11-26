# Plan: tidy-up, #176 and #178 (2026-11-26)

## Review of the codebase

Two cleanup passes already ran on 2026-11-24 (#136, #139) and the CI/speed work followed. This pass found the structure sound: `createGoalCore` only wires services, the test hosts are shared in `tests/support`, and `check`, `lint` and the full suite pass on main (1363 pass, 5 skipped).

Left over, and fixed here:
- 20 exported types and functions that nothing outside their own file used. They are now private.

Looked at and left alone:
- `tests/goal-context.test.ts` and `tests/goal-session-safety.test.ts` use tiny hand-made stubs. They test one registration call each, so moving them to the shared harness would add code, not remove any.
- The `legacy-v1` prompt profile is still there as an opt-out. Removing it changes behaviour for anyone who set it, so it needs its own decision.

## Open items

| Item | Decision |
| --- | --- |
| #178 `/goal-refresh` serves a stale snapshot | Fix. Real bug, easy to reproduce. |
| #176 and PR #177: finished phase is never pointed at | Fix. Real bug. The PR is sound but adds a 100-line test file and an exported helper for one line of prompt, so we rewrite it smaller and credit the author. |
| PR #177 | Close with a thank-you once the fix merges. |

## Changes

### #178: refresh must rescan

- `storage/goal-files.ts`: add `refreshActiveGoalPool(ctx)`. It drops the pool, listing and parse caches for the goals root, scans every file, rewrites the snapshot and fills the pool cache.
- `goal-commands.ts` `runGoalRefresh`: use it for the "after" pool, then call `reconcileFocusedGoalFromDisk` so the focused goal picks up the new revision.
- The refresh report now also lists goals whose revision changed, because an in-place edit keeps the same ids and used to say "no changes".
- The write path is untouched, so revision conflict checks and the zero-I/O steady state stay as they are.
- Tests: stale snapshot reproduced, refresh returns the disk revision, the snapshot is rewritten; the diff reports a revision change.

### #176: name the phase that needs closing

- `prompts/goal-prompts.ts` `taskListBlock`: when no task is current and a pending phase has all subtasks complete or skipped, add one `Wrap-up:` line under the header. Checklists (`lightweightSubtasks`) and `disableTasks` get nothing. Display only, nothing is written back.
- The block is part of the per-turn snapshot, so the line only appears in a snapshot that was changing anyway. No cache prefix change.
- Tests in `goal-prompts.test.ts`: line and its position, skipped counts, open and nested children, current task set, checklist, tasks off.

## Check

`npm run check`, `npm run lint`, `node scripts/run-unit-tests.mjs all`, and CI (including the bench gate and the cache gates).

## Credits

- #176 and #177: yanhuojiyusheng (idea, wording and test cases).
- #178: selimerunkut (diagnosis and the suggested fix).
