# Advanced usage

For installation, goal workflows, commands and the settings overview, see the [README](../README.md).

## Automatic continuation and optional execution contracts

Active goals continue automatically after successful executions, including reasoning-only responses and final-task verification. No tool call, task update, scheduling declaration, or cooldown is required. Unproductive loops remain possible; optional run limits and token budgets still apply.

Enable `strictExecutionContract: true` in `/goal-settings` or your global/project settings to require explicit ready/wait decisions. In that mode, a missing decision permits one repair prompt within the remaining allowance, then pauses. This is a user preference; agents should not enable it merely to continue.

Set an appropriate allowance in `/goal-settings`, or in `.pi/pi-goal-x-settings.json`:

```json
{ "maxAutonomousRuns": 20 }
```

Agents may edit this setting. Changing it does not replenish consumed runs; explicit `/goal-resume` renews the period and continues now, including from a waiting goal. No configured allowance is required unless the effective limit is zero, which disables resume. Tool calls within a run are not separate runs. Existing token budgets still apply.

Explicit `ready` is optional in default mode. New `wait` declarations require strict mode; otherwise they return a non-terminating error. Previously saved waits retain their deadline, checks, and repair rules when upgrading or disabling strict mode, and may be re-declared with the same identity. Mode changes never resume a paused goal or renew consumed runs.

```js
update_goal({ continuation: { kind: "ready", next_action: "Verify the build artifacts" } })
update_goal({ continuation: {
  kind: "wait", reason: "Await the remote build",
  deadline: "2026-09-15T12:00:00Z",
  polling: { interval_seconds: 60, max_checks: 3 }
} })
```

Use a future deadline appropriate to the task. Omit `polling` for an event-only wait. Successful declarations terminate the execution segment. On a scheduled check, reuse the returned `wait_id` and original deadline, omitting `polling`; remaining checks cannot be reset. A ready decision ends the wait. Time spent waiting is not active execution time.

A background task the agent starts is detected from the producer's own tool result, and the goal waits for its report instead of continuing into polls. No declaration, strict mode, or setting is involved: the wait is system-managed, and the goal stays under its normal continuation rules. The task's result report wakes the goal; if none arrives, one scheduled re-check runs at the wait interval (10 minutes), and the standing deadline then pauses the goal. Waiting on the tracked task again from a check keeps the original deadline, so a lost report cannot loop forever. Polling the tracked task is refused while the goal sleeps; `stop` still cancels it.

The dashboard, `/goal-status`, and `get_goal` show scheduling state, timing, checks, and allowance consumption. Expired waits and exhausted checks or allowance pause without another model call. Waits survive reopening the same session, without replaying missed checks; Pi must remain open for timers to execute. Another session requires explicit resume to take ownership. An ambiguous interrupted dispatch requires resume instead of automatic replay.

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

For the reported OpenCode model, a narrowly scoped Pi `models.json` override makes the supported Pi 0.84.1 adapter send `strict: false` for ordinary tools:

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

## Diagnostics and recovery

Use `/goal-status verbose` for effective settings and storage location, `/goal-status health` or `/goal-recovery` to check for problems, and `/goal-refresh` to reload saved goals and settings after external changes. `/goal-recovery repair` offers repairs after confirmation.
