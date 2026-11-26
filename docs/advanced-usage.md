# Advanced usage

For installation, goal workflows, commands and the settings overview, see the [README](../README.md).

## Automatic continuation and optional execution contracts

Active goals continue automatically after successful executions, including reasoning-only responses and final-task verification. No tool call, task update, or scheduling declaration is required, but a goal that goes `maxIdleTurns` automatic turns in a row without a single tool call is paused (see below).

Default continuation is immediate. To slow repeated replies without recognized work, enable **slow repeated idle replies (opt-in)** under Advanced execution in `/goal-settings` (`idleContinuationBackoff: true`). Use the scope switch to choose a global default or a project override. An explicit project `false` overrides global `true`; removing the override restores inheritance.

When enabled, one execution without recognized work continues immediately. Further such executions wait 30, 60, 120, 240, then 300 seconds between attempts. Work observed anywhere in the execution or a change to the objective, requirements or tasks resets the delay. Goal inspection, echo-only calls, accounting and scheduling declarations alone do not reset it. This heuristic may delay reasoning or unfamiliar custom tools, and repeated recognized tool calls can bypass it. It reduces request rate; it does not guarantee progress or finite spending. Use a run allowance or token budget for a hard limit.

The delay survives reloads and shows a relative time, local clock time and resume command. Waiting spends no autonomous runs or active time. Turning the option off cancels a pending delay promptly without renewing spent runs or resuming a paused goal. Turning it on starts observing a subsequent execution, rather than classifying work retroactively. Old saved delay metadata has no effect without opt-in. `/goal-resume` renews the run allowance and continues now; incoming user/producer messages remain ordinary host work outside that allowance. Strict waits and provider-error recovery keep their separate timing.

Enable `strictExecutionContract: true` in `/goal-settings` or your global/project settings to require explicit ready/wait decisions. In that mode, a missing decision permits one repair prompt within the remaining allowance, then pauses. This is a user preference; agents should not enable it merely to continue.

Set an appropriate allowance in `/goal-settings`, or in `.pi/pi-goal-x-settings.json`:

```json
{ "maxAutonomousRuns": 20 }
```

The `Autonomous runs: used/limit` line reports a finite allowance and is left out when
allowance is unlimited. Set `showAutonomousRuns` to `false` to drop it for a finite
allowance as well; it defaults to `true`.

Agents may edit this setting. Changing it does not replenish consumed runs; explicit `/goal-resume` renews the period and continues now, including from a waiting goal. No configured allowance is required unless the effective limit is zero, which disables resume. Tool calls within a run are not separate runs. Existing token budgets still apply.

`showContextUsage` defaults to `false`. Set it to `true` to include context-window occupancy in new goal prompt snapshots. Accounting, budgets and automatic compaction continue normally. Existing snapshots remain historical.

Explicit `ready` is optional in default mode. A goal saved before next actions were
removed still loads, with its `nextAction` field stripped during normalization.
New `wait` declarations require strict mode; otherwise they return a non-terminating error. Previously saved waits retain their deadline, checks, and repair rules when upgrading or disabling strict mode, and may be re-declared with the same identity. Mode changes never resume a paused goal or renew consumed runs.

```js
update_goal({ continuation: { kind: "ready" } })
update_goal({ continuation: {
  kind: "wait", reason: "Await the remote build",
  deadline: "2026-09-15T12:00:00Z",
  polling: { interval_seconds: 60, max_checks: 3 }
} })
```

Use a future deadline appropriate to the task. Omit `polling` for an event-only wait. Successful declarations terminate the execution segment. On a scheduled check, reuse the returned `wait_id` and original deadline, omitting `polling`; remaining checks cannot be reset. A ready decision ends the wait. Time spent waiting is not active execution time.

The dashboard, `/goal-status`, and `get_goal` show scheduling state, timing, checks, and allowance consumption. Expired waits and exhausted checks or allowance pause without another model call. Waits survive reopening the same session, without replaying missed checks; Pi must remain open for timers to execute. Another session requires explicit resume to take ownership. An ambiguous interrupted dispatch requires resume instead of automatic replay.

## Stopping a goal that has gone quiet

If the agent only talks for four automatic turns in a row (no tool call at all, `get_goal` aside), the goal pauses and says why. Any tool call resets the count. Use `/goal-resume` to carry on.

Change the number with `maxIdleTurns` in `/goal-settings` or a settings file. `0` turns this off. It is also off when **slow repeated idle replies** is on, because that option already slows idle turns instead of stopping them.

```json
{ "maxIdleTurns": 6 }
```

`maxGoalMinutes` pauses a goal once it has used that many minutes of active time (default `0`, no limit). The check runs between automatic turns, so a single long turn can finish first. Raise the value, then `/goal-resume`.

## Holding while background work runs

Other extensions can tell pi-goal-x that background work is running, so it does not queue continuation turns that have nothing to do:

```js
pi.events.emit("pi-goal:busy", { source: "my-subagents", count: 2 });  // two jobs running
pi.events.emit("pi-goal:busy", { source: "my-subagents", count: 0 });  // all done
```

While any source reports a count above zero, no continuation is queued. The goal stays active and spends no run allowance or active time. When every source reports zero, one continuation goes out. If a source never reports back, one normal continuation goes out after 60 minutes. A host that does not send these events behaves as before. A job's own completion message still starts a turn as usual.

## Verify command

A goal can name a command that must pass before the auditor runs. Put it in the verification contract, in backticks:

```text
Verification contract: the export tests pass. Verify command: `npm test`
```

When the agent asks to complete, pi-goal-x runs the command in the project folder (5 minute limit). If it fails, the completion is rejected with the end of its output and no audit is spent. If it passes, the output is given to the auditor as evidence.

A command only runs after you have seen it: confirming a draft or a tweak, or typing `/goal-direct`, trusts that exact command for that project. The trust list is `pi-goal-x-trusted-verify.json` in your Pi agent folder, not in the project, so a goal file that arrives with a repository cannot run commands on its own. A command that has not been confirmed is skipped, and you are told.

## Audit limits

Audits have no limit by default. To stop a runaway audit, set `auditorTimeoutMinutes` (minutes) or `auditorMaxToolCalls`; `0` means no limit. An audit that goes past either ends without a verdict, the goal stays open, and requesting completion again starts a new audit.

## Draft style

`draftStyle` controls how `/goal` and `/sisyphus` begin. `"ask"` (the default) lets the agent ask questions first. `"propose"` makes it draft at once and list its guesses on an `Assumptions:` line, which you can correct before confirming. Set it in a settings file.

## Background producer integration

Budget-controlled producers emit a scheduler signal instead of starting their own model turn:

```js
pi.events.emit("pi-goal:wake", { goalId, waitToken });
```

`waitToken` is returned in the wait declaration's tool-result details. Register it before the producer completes, or retain the completion until registration (for example, observe the `update_goal` tool result in the host adapter). The token changes after consumption and re-declaration. A matching signal received before agent settlement is retained; duplicate, stale and wrong-goal tokens are ignored. A signal and timer can claim only one wake.

Existing producers that directly send `triggerTurn`/`followUp` messages still run as ordinary host work and supersede old pending decisions. Those independently started turns are **outside this extension's allowance**; use `pi-goal:wake` to put them through its spending gate. The allowance also does not limit Pi's own within-run tool loop or native retries. It bounds the goal extension's kickoff, continuation, check, signal, repair and recovery dispatches.

## Prompt caching

Goal state is refreshed at the request tail while the system prompt and conversation prefix stay stable. Pi retains control of provider cache settings. See [prompt caching](prompt-caching.md) for explicit-cache handling, validation, and cache invalidation boundaries.

## Changing a token budget

Use the existing tweak flow: `/goal-tweak remove the token budget` or `/goal-tweak set the token budget to 50000`. The proposal shows the current and proposed limits before confirmation. A budget is a total lifetime limit, not an additional allocation; consumed tokens and completed work are preserved. Omitting a budget change retains the current limit.

After confirmation, a goal stopped only by its budget can continue if the revised limit allows it and scheduling permits. A still-exhausted budget keeps it stopped. Other-session ownership, interrupted execution and exhausted autonomous-run allowances still require their existing recovery steps. Creation and tweak results always show the effective budget.

## Optional arguments on Responses-compatible providers

Some Pi `openai-responses` configurations omit the wire-level `strict` flag. OpenAI Responses may normalize schemas into strict mode when that flag is omitted. This can conflict with optional goal arguments; it is separate from pi-goal-x's `strictExecutionContract` scheduling setting.

For the reported OpenCode model, a narrowly scoped Pi `models.json` override makes the Pi adapter send `strict: false` for ordinary tools:

```json
{
  "providers": {
    "opencode": {
      "modelOverrides": {
        "gpt-6-astra": { "compat": { "supportsStrictMode": true } }
      }
    }
  }
}
```

The capability flag permits the adapter to send the explicit non-strict opt-out; it does not request strict sampling for ordinary goal tools. Merge this into existing model configuration and reload Pi. This is a provider-specific workaround, not a guarantee about third-party model behavior. The local reproduction inspects requests before transmission; the issue's live OpenCode A/B result has not been independently reproduced. See [issue #59](https://github.com/tmonk/pi-goal-x/issues/59) and [OpenAI's function-calling documentation](https://developers.openai.com/api/docs/guides/function-calling).

## Sharing a goal pool across worktrees

By default goals stay in `<cwd>/.pi/goals`. Set `goalsRoot` in your project or global settings to an absolute directory (or `~/path`), or set `PI_GOAL_ROOT` for the session. Precedence is environment, project, global, then the existing default. For example:

```json
{ "goalsRoot": "~/work/project-goals" }
```

Worktrees pointing to the same root share goals, archives, ledger and locks; focus remains session-local and execution ownership still requires explicit resume. The working directory for tools and audits is unchanged. Existing goals are not moved automatically. Reload/reopen the session after changing roots; `/goal-refresh` refreshes the selected pool. `/goal-status verbose` shows the effective location. Saved goal paths remain logical `.pi/goals/...` paths within that selected pool.

`hideUnfocusedPrompt: true` suppresses ordinary unfocused reminders to the model independently of `hideUnfocusedBanner`; neither changes focus or bypasses stale-checkpoint checks.

Token usage shown in the dashboard is cumulative across goal turns. The model receives a separate context snapshot when Pi can supply one; unavailable context is never reported as zero. Retained snapshots are bounded and newer snapshots supersede older ones.

## Language

The text shown in the host UI can be translated. English is the default. Set `locale` in your project or global settings, or set `PI_GOAL_LOCALE` for the session. Precedence is environment, project, global, then English. Text without a translation, and everything sent to the model, stays in English. No translations ship yet; the steps for adding one are in `specs/2026-11-24-localisation/TECH.md`.

## Diagnostics and recovery

Use `/goal-status verbose` for effective settings and storage location, `/goal-status health` or `/goal-recovery` to check for problems, and `/goal-refresh` to reload saved goals and settings after external changes. `/goal-recovery repair` offers repairs after confirmation.
