# TECH: wait for a detected background task

## Detection

`extensions/goal-background-task.ts` (new, no runtime dependencies beyond `asRecord`):

- `observeBackgroundTask(event)` reads a `tool_result`-shaped event and returns `{ kind: "running", task }`, `{ kind: "settled", taskId }`, or `null`.
- Lifecycle value: `status` or `phase`, read case-insensitively. Running: `starting | running | background | active | pending | queued | working | in_progress`. Settled: `completed | done | succeeded | failed | cancelled | aborted | stopped | …`.
- Value and id may be flat on the result or nested under a `task` object. A producer is free to nest it (`pi-background-tasks` returns `details: { task: { id, name, command, status, … } }`), so the flat fields are read first and the nested task object is used when the flat fields carry no lifecycle value.
- Id: `taskId | task_id | agentId | agent_id | id`. Label: `summary | label | title | name | description | command`. Untrusted producer text is collapsed to one line and capped at 120 characters before it reaches a prompt.
- A running value with no id still parks the goal; it simply cannot match a poll, which needs the id.
- `isError` results are ignored, free text is never parsed, and a result with an id but no lifecycle value is not a running task.
- Producers participate by convention, not by name, and the three verified producers use three different shapes: `@4fu/pi-pwsh` reports a flat `status`, `@tintinweb/pi-subagents` reports a flat `status: "background"` for a detached agent, and `pi-background-tasks` nests `{ task: { id, status } }`. There is no tool-name list, and no dependence on an argument flag: the flags a harness happens to use are not observable from here.

`isPendingTaskPoll(toolName, input, taskId)` implements the poll rule. It matches on the **task id**, not the tool name, so any producer's polling tool is covered: `pwsh { taskId }` (which keeps its `stop` exception), `TaskOutput { task_id }`, a subagent result getter taking `agent_id`, or a tool this extension has never seen. A call that acts on the task instead stays allowed: a tool whose name contains an action verb (`TaskStop`, `steer_subagent`, …), or arguments that pass `stop`, `cancel`, or an action value (`stop | cancel | kill | terminate | abort | steer | interrupt | retry | resume | delete`). An empty `taskId` never matches, so a producer that reports no id has nothing blocked.

## Scheduler

`extensions/goal-scheduler.ts`:

- `noteToolResult(event)` is memory-only. It records the pending task, clears it when a result reports the same task settled, and stays inert unless `canWaitForTask()` (focused goal `status === "active"` and `autoContinue`) holds. A later result also records post-detection progress (`notePostTaskProgress`): the flag is set once per run, is skipped for goal bookkeeping and for a refused poll of the tracked task, and the result that detected the task never counts.
- `settled()` calls `deferForTaskProgress()` when the run recorded post-detection progress, and `deferForTask()` in place of `implicitReady()` when a task is pending and the run added nothing new. The agent's own declaration still wins, and the availability check and repair path are untouched.
- `deferForTask()` writes the wait: `taskId` = the tracked id, `reason` = `Waiting for <label> to finish.`, `deadline` = now + `BACKGROUND_TASK_WAIT_MS` (10 min) + 60 s margin, `intervalMs` = 10 min, `nextCheckAt` = now + 10 min, `remainingChecks` = 1. Waiting on the same task again keeps the wait id and the original deadline; once the deadline has passed it raises no further wait, so the standing deadline pause governs. It then clears any queued continuation and calls `schedule()`, which arms the re-check timer.
- `deferForTaskProgress()` defers the wait instead of raising it: it persists a `ready` decision whose `nextAction` is the deferral steering text (mirroring the declared-ready dispatch), clears the per-run progress flag, and calls `schedule()`. A later settle with no new work raises the wait through `deferForTask()`, which is what bounds the deferral.
- `strict()` treats a wait with a `taskId` as system-managed, so it does not put the goal under the explicit execution contract. `implicitReady()` drops a task wait when the goal continues.
- `begin()` keeps the pending task across a run so the deferred run can still raise the wait, and resets only the per-run progress flag. `takeover()`, `restore()`, and `shutdown()` clear both; `takeover()` clearing it is the wake, since the task's own report is what reaches it.
- `blocksTaskPoll(toolName, input)` refuses a second wait on the tracked task while the goal can wait.

`extensions/goal-scheduler-state.ts`: `GoalWait.taskId?` with normalization, `GoalSchedulerState.postTaskProgress?` (optional boolean; a record that omits it normalizes cleanly, so there is no schema version bump), and the scheduler summary. A task wait is folded into the runs line (`Autonomous runs: N/unlimited. Waiting for pwsh task ps_… to finish. Next check <iso>.`) so the widget gains no rows. Declared waits keep their existing two-row form.

## Events and prompts

`extensions/goal-events.ts`:

- `tool_result` calls `noteToolResult` (detection plus post-detection progress) and appends `backgroundTaskNotice(task)` to the producer result when a task is tracked. The notice also asks for work that does not depend on the result and for a `ready` declaration when work remains for a later turn.
- `backgroundTaskDeferralPrompt(task)` is the `nextAction` of a deferred settle, and `backgroundTaskWaitPrompt` carries the same steering while the goal is `waiting`.
- `tool_call` refuses a poll via `blocksTaskPoll(event.toolName, event.input)`. The pinned pi API carries tool arguments on `input`; the handler must not read `args`.
- The injected state appends `backgroundTaskWaitPrompt({ taskId, reason })` while the goal's scheduler is in the `waiting` phase.

## Invariants

- Waiting never changes the goal lifecycle status; the goal stays `active`, so no `/goal-resume` is needed to continue.
- Waiting consumes no autonomous run until the re-check or the wake actually dispatches. A deferral dispatch is an ordinary autonomous run and does count against the allowance.
- A wait raised by the runtime cannot be re-declared by the model (the declared-wait gate still applies to `update_goal`).
- Widget line count is unchanged by waiting, per `specs/2026-08-11-stable-widget-height`.

## Tests

`tests/goal-background-task-pause.test.ts` (16 tests, all passing):

1. only structured producer results identify detached work (including: free text and errors never do);
2. producer label text is bounded and single-line;
3. a poll of the tracked task is blocked; `stop`, other tasks, and other tools are not;
4. a task wait adds no scheduling rows;
5. detection stays inert while the focused goal cannot wait;
6. a detected task replaces the implicit continuation with a task wait;
7. the task report wakes the goal and drops the wait;
8. a lost report re-checks once, then the standing deadline parks the goal;
9. an unrelated result and an untracked goal keep the normal loop;
10. the hooks teach the model to stop and refuse a second wait;
11. a task wait keeps the latched dashboard height and its box footer (renders the compact dashboard, applies `applyStableHeightBound` across a shared regime, and requires the footer);
12. a settle after post-detection work defers the task wait;
13. the following settle without new work raises the wait;
14. goal bookkeeping after detection does not defer the task wait;
15. the launch result itself does not defer the task wait.

Mutation checks (each guard was verified to fail when its fix is reverted):

- reading `args` instead of `input`: test 10 fails.
- restoring the wait's extra rows: tests 4 and 11 fail.

## Verification

- `npx tsc --noEmit` 0, `npm run lint` 0.
- `npm run test:all`: 1096 tests, 1077 pass, 17 fail. The upstream tree with the same runner reports 1086 / 1067 / the identical 17 names, so the delta is the new tests in `tests/goal-background-task-pause.test.ts` (11 at that measurement; the file now holds 16) and there is no regression. Those 17 are Windows environment failures (symlinks, POSIX path resolution, CRLF goldens, and the recover script).
- `npm run test:selfcheck` OK (78 unit + 1 integration + 5 e2e entries match).
- `npm run context:gate` PASS (24 fixtures), `experiments/context/retention-check.mjs` exit 0, `scripts/test-update-ranking.py` OK.
- Two CI steps fail on this Windows machine for pre-existing reasons unrelated to the change: `scripts/test-publish-workflow.mjs` splits the workflow YAML on `"<<'NODE'\n"` and the checkout has CRLF, and `provider-crosscheck.mjs` expects `/fixture` where Windows renders `C:/fixture`. Neither file is touched by this change.
- Not run locally: the CI runtime benchmark gate (`bench:naf` plus `bench:gate:naf`), which needs a base checkout and a full benchmark run.

## Live evidence

Three producers, one goal, each cycle ending on the producer's own report. `(b)` is the persisted record, sampled once per second by a detached process that copied the goal file (so the evidence does not depend on a model turn, which cannot exist while the goal sleeps):

| Producer | Shape it reports | Notice | Wait recorded | Poll refused |
| --- | --- | --- | --- | --- |
| `@4fu/pi-pwsh`, 60 s | flat `status: running` | yes | yes, 23 samples `waiting` + `taskId=ps_bfb1cf70` | yes, `pwsh` |
| `@tintinweb/pi-subagents`, 54 s | flat `status: background` | yes | yes, ~43 samples + `taskId=d3d7c431-49f3-4cb` | yes, `get_subagent_result` |
| `pi-background-tasks`, 45 s | nested `task: { id, status }` | yes | yes, samples `snap_019`-`snap_045` + `taskId=bc5eea31d` | yes, `bg_status` |

In every cycle `Autonomous runs` stayed at 1 and the wake came from the producer's terminal notification. A fourth observation belongs here because it shaped the design: a 5.6 s subagent finished before its turn ended, so no wait was raised and none was needed, because the report had already arrived and `takeover()` had cleared the pending task.

Two later observations, both live in clean sessions, cover the deferral:

- A single background task and nothing else: the goal pauses on the first settle — `"used": 0`, `"phase": "waiting"`, `"taskId": "ps_5123bc5a"`, `"reason": "Waiting for pwsh task ps_5123bc5a to finish."`, `"kind": "wait"`. The widget read `goal: waiting`, and the task's own report woke the goal about two minutes later (`completion_requested` + `audit_started`). Observed twice independently (a second goal archived with `"phase": "waiting"`, `"used": 0`), so the original behaviour is intact and no deferral run is consumed when there is no other work.
- A background task plus an independent task in two steps: the goal did not sleep first. Step 2 was written 14.4 s after step 1 while the task was still running, and the record showed `"used": 1` with `"decision": { "kind": "ready", "nextAction": "Task B step 2: append …" }` — the agent used the ready declaration the hardened notice asks for.

The third producer also exposed the only generality bug this testing found. `pi-background-tasks` was run blind (its result shape was not read first), it was not detected, and only then was the nested `{ task: … }` container discovered from the persisted snapshot on disk and handled. Its `bg_run` shells out through `cmd.exe`, not bash or PowerShell.
