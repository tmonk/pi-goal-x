# MILESTONES: background-task wait

## 2026-09-24 — feature built

Detector (`extensions/goal-background-task.ts`), the wait in `GoalScheduler.settled()` via `deferForTask()`, the poll gate, the two prompt blocks, and 8 tests. Unit suite compared against a stashed baseline: the same 15 Windows-only failures before and after, so no regression. Decision at this point: reuse the existing wait machinery and add no setting.

## 2026-09-24 — first live run (600 s), one real defect

`Start-Sleep -Seconds 600` with `wait: 0`. The wait held for the full ten minutes, no model turn ran, and the goal resumed 12 s after the task reported. The poll gate did **not** refuse a poll: `pwsh {taskId: …}` executed normally.

Root cause: the handler read `asRecord(event)?.args`, but the pinned pi API carries tool arguments on `input` (`ToolCallEventBase`; the runtime emits `{ type: "tool_call", toolName, toolCallId, input }`). The gate was inert in every live session while its unit test passed, because the test built the event shape I had invented. The same wrong field name sat in the pre-existing `isMeaningfulProgressToolCall(toolName, asRecord(event)?.args)`, which uses args to exclude `.pi/goals` reads and bare `echo` commands, so those exclusions were dead too. Both fixed; the test now builds the documented shape, and a mutation check proves it fails when the handler reads `args` again. Lesson recorded: build test events from the API contract, and verify gates live.

## 2026-09-24 — layout defects

1. The wait raised a `ctx.ui.notify(...)`. `ui.notify` renders a transient status row, so the editor grew and the widget above it was clipped until the row expired. Removed: the wait is visible in the widget's scheduling rows, and a routine event has nothing to announce.
2. The footer was still clipped without any notification. Root cause: `stableHeightRegime()` keys the height latch on goal id / status / state kind / expanded / debug / disableTasks / hasTasks, so a wait is not a regime change; `applyStableHeightBound` head-slices growth, so the two rows a wait added were cut off the bottom and took the box footer (`╰─ Ctrl+Shift+T: expand tasks …`) with them. Decision: a system wait adds no rows and rides the runs line, because the status row already reads `Waiting`. Two guards added (no newline in the summary; compact-dashboard render under a shared latched regime must keep the footer), both verified by mutation.

## 2026-09-24 — audit rejection and rework

The first completion request was rejected: step 3 of the test objective asked for the refusal "verbatim", and there was no refusal to quote, because the gate was inert during that run. Re-doing it needed a reload so the fixed module was loaded. After the reload the same check produced a live refusal, quoted verbatim in the completion evidence and written to `test-wait-pollgate.txt`.

## 2026-09-24 — detection made inert

While preparing the PR, a long-running shell call in a session whose goal was already complete showed the notice still claiming the goal was waiting. Fixed: `noteToolResult` and `blocksTaskPoll` are inert unless the focused goal is `active` with `autoContinue`, and the notice no longer claims a pause. Test 5 covers it.

## 2026-09-24 — PR preparation

- CI gates measured locally: `check`, `lint`, the ranking updater tests, `test:selfcheck`, `context:gate` (PASS), the retention check, and `test:all`. `test:all` on the branch is 1096 / 1077 / 17, and the upstream tree with the same runner is 1086 / 1067 / the identical 17, so the delta is the 11 new tests. The 17 are Windows environment failures.
- Two CI steps fail on Windows for pre-existing reasons in files this change does not touch: the publish-workflow test (splits the YAML on `"<<'NODE'\n"`, defeated by CRLF) and the provider cross-check (`/fixture` expected, `C:/fixture` rendered). The CI runtime benchmark gate was not run locally.
- This spec directory added, per `AGENTS.md`.

## 2026-09-24 — made producer-agnostic

Review feedback: the feature must cover any asynchronous task, not just `@4fu/pi-pwsh`, because that is one extension among several. Inspection agreed on both counts.

- The args-based rule ("a launch with `run_in_background`") was unverifiable: that string appears nowhere in the installed packages, and the subagent tools in this session come from the harness rather than from a pi package. An unverifiable rule is the same class of mistake as the inert poll gate, so it was removed rather than kept as dead code.
- Detection now reads `status` **or** `phase`, plus the running values either field uses, so `@4fu/pi-pwsh` and the shared task catalog are both covered, and a subagent, queue, or scheduler package that reports either value needs no new contract.
- The refusal now matches the task id instead of a tool-name list, so `TaskOutput`, a subagent result getter taking `agent_id`, and any future tool are covered. Acting on the task (cancel, stop, steer, retry) stays allowed by tool name or by argument.
- The spec examples and the wait wording were rewritten around producers rather than around pwsh.

Tests updated: `phase`-based detection, an id alone is not a running task, subagent-style and unseen tools blocked by id, `steer_subagent` and `TaskStop` allowed.

## 2026-09-24 — three producers verified live

One goal, three cycles, each ending on the producer's own report. The persisted record is sampled once per second by a detached process, because a model turn cannot exist while the goal sleeps, so the wait itself has to be observed from outside.

None of the three producers is a dependency of this repository. They are separate pi extensions, and detection reads only the shape each result reports, so no producer has to be supported by name. `pi-background-tasks` was installed only for this test and removed afterwards.

| Producer | Shape it reports | Notice | Wait recorded | Poll refused |
| --- | --- | --- | --- | --- |
| `@4fu/pi-pwsh`, 60 s | flat `status: running` | yes | 23 samples + `taskId` | yes, `pwsh` |
| `@tintinweb/pi-subagents`, 54 s | flat `status: background` | yes | ~43 samples + `taskId` | yes, `get_subagent_result` |
| `pi-background-tasks`, 45 s | nested `task: { … }` | yes | `snap_019`-`snap_045` + `taskId` | yes, `bg_status` |

Findings from this pass:

- A 5.6 s subagent finished before its turn ended, so no wait was raised, and none was needed: the report had already arrived and `takeover()` had cleared the pending task. Recorded as cycle 2a.
- `@tintinweb/pi-subagents` reports only `status: "background"` and `status: "running"`. `background` was missing from the running set, so a detached agent would have slipped past detection. Added from the extension's own source, not by guessing.
- The blind run failed, and only then was its shape read: `bg_run` returns `details: { task: snapshot }` with `{ id, name, command, status }`, so the value sat one level below the flat fields. Nested-task support and `name` as a label field were added, and the cycle was re-run to confirm (`snap_019`-`snap_045` waiting on the task id).
- `bg_run` shells out through `cmd.exe`; a POSIX `sleep` command fails in 136 ms.

## Open items

- The scheduled re-check is covered by unit tests only. Both live tasks reported before their re-check, so exercising it live needs a task that outlives ten minutes.
- `BACKGROUND_TASK_WAIT_MS` is a constant; make it a setting if reviewers want one.
- Two unrelated fixes travel with the feature (tool arguments read from `input`; the Windows unit runner). They can be split into their own changes on request.
