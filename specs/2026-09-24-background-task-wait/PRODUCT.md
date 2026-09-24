# Wait for a detected background task instead of polling it

## Problem

With `autoContinue` on, a goal that starts a detached task has nothing useful to do next. The loop keeps scheduling runs, and the only thing a run can do is poll that task. A ten-minute build becomes dozens of `pwsh {taskId}` and `TaskOutput` calls for a result pi delivers anyway.

The existing scheduler wait cannot fix this on its own. A `wait` is only reachable through `update_goal({ continuation: { kind: "wait", ... } })`, and that declaration requires `strictExecutionContract`. In the default mode `GoalScheduler.settled()` calls `implicitReady()` and the loop continues, so a goal that started a long task keeps polling it.

## Behaviour

A tool result that leaves work running records a scheduler wait in place of the next automatic run. The user sees the widget report `Waiting` with the tracked task and the next check, and the goal stays quiet until the task reports.

1. **Detect.** A producer result that reports a non-terminal lifecycle value marks detached work: `status` (as `@4fu/pi-pwsh` reports), `phase` (as the shared task catalog reports), or any equivalent value such as `starting`, `running`, `active`, `pending`, `queued`, `working`, `in_progress`. Errors are ignored.
2. **Wait.** At settlement the goal records a wait on the task and stops scheduling runs. The wait is system-managed: it needs no setting and does not put the goal under the explicit execution contract.
3. **Wake.** The task's own result report arrives as a host message, which already supersedes a pending decision, so the goal continues with the result in context. One scheduled re-check at ten minutes covers a report that never arrives, and the standing deadline then pauses the goal, so a lost report cannot loop forever.
4. **Refuse the poll.** While the wait holds, any call that names the tracked task is refused, whatever tool it uses: `pwsh { taskId }`, `TaskOutput { task_id }`, a subagent result getter that takes `agent_id`, or a tool this extension has never seen. Calls that act on the task instead (cancel, stop, steer, retry) stay allowed.
5. **Steer.** The producer result gains a `[PI GOAL WAITING ON BACKGROUND TASK]` block, and the injected state carries a standing wait block, so the model stops instead of polling.

## Decisions

- **Producer-agnostic by construction.** Detection reads lifecycle values and ids from the producer's own result, never a tool name and never free text. `@4fu/pi-pwsh` already reports `status` and `@4fu/pi-tasks` already reports `phase`, so both participate with no new contract, and a subagent, queue, or scheduler package that reports either value (plus an id) is covered by the same rule. The poll refusal matches on the task id for the same reason.
- **No new tool and no new lifecycle status.** The feature reuses `GoalSchedulerState.wait` and the `waiting` phase, so `schedule()`, `claim()`, and the deadline rules are unchanged.
- **No setting.** Waiting for work pi already reports on is not a preference, so the behaviour is unconditional. Only the ten-minute re-check interval is a constant, and it can become a setting if that is wanted.
- **System waits bypass the declared-wait gate.** `strictExecutionContract` gates *agent declarations*. A wait the runtime raises is not a declaration, so it stays outside the contract, and a goal does not owe a disposition for it.
- **A system wait adds no widget rows.** The widget latches its rendered height per state regime and head-slices growth (see `specs/2026-08-11-stable-widget-height`), and a wait is not a regime change, so rows added while waiting were sliced off the bottom and took the box footer with them. The wait rides the existing runs line instead.
- **Detection is inert unless the focused goal can wait.** A complete, paused, or non-continuing goal neither records a task nor tells the model it is waiting.

## Non-goals

- Producers that report no lifecycle value are not detected, and their goals behave exactly as before. An agent that needs a wait anyway can still declare one itself in strict mode.
- The extension does not inspect task internals on disk. Detection uses the tool result only.
- No free-text parsing. An unrelated result must never be able to pause a goal.
