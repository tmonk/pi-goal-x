# pi-goal-x

`pi-goal-x` is a long-running goal extension for [pi](https://github.com/earendil-works/pi-coding-agent). It gives the agent a durable objective, a visible lifecycle, five schema-gated model tools, structured tasks, and independently audited completion.

The extension is designed around one rule: **the user owns intent; the agent executes only after the goal is explicit and confirmed**.

## Features

- **Two goal styles** — Regular goals for open-ended research and implementation. Sisyphus goals for patient ordered execution, one step at a time.
- **Guided goal creation** — `/goal [seed]` and `/sisyphus [seed]` let the agent clarify intent, use a questionnaire when useful, propose the full goal and a task tree, and wait for explicit confirmation. `/goal-direct <objective>` and `/sisyphus-direct <objective>` are the fast bypass.
- **Full lifecycle** — Pause, resume, clear, and complete through user commands and the five model tools. Auto-continue keeps the agent working across turns until completion, interruption, or the empty-turn guard.
- **Multiple open goals** — Keep several goals in `.pi/goals/`. Each session focuses one at a time; switch with `/goal-focus`.
- **Above-editor status widget** — See the current goal, status, file path, and progress at a glance while the agent works.
- **Structured task lists with subtasks** — Break goals into trackable tasks. Agents can mark individual tasks or subtasks complete without stopping the turn. Subtask IDs are validated for uniqueness and depth.
- **Verification contracts** — Attach plain-text requirements to a goal or task (e.g. "Run npm test, zero failures"). The independent auditor verifies them from actual evidence; per-task contracts require evidence on `update_goal_task`.
- **Independent completion auditor** — When a goal is marked complete, a separate pi agent inspects the workspace, verifies every success criterion, and approves or rejects before the goal is archived. You can press Escape during an audit to abort it. Configure the auditor model via `/goal-settings`.
- **Compact execution surface** — Normal work uses five goal tools (`create_goal`, `get_goal`, `update_goal`, `set_goal_tasks`, `update_goal_task`), or three when tasks are disabled. A user-started draft temporarily exposes only `goal_question`, `goal_questionnaire`, and `propose_goal_draft`; confirmation restores the execution profile without touching ordinary Pi work tools.
- **Immutable objective** — The agent cannot silently change your goal. Objective updates happen through user-owned `/goal-tweak`.
- **User-owned lifecycle** — Pause, resume, clear, focus, and settings are immediate user commands; the model reports complete, blocked, or (with a reason) paused outcomes.
- **Disk-backed state** — Active and archived goals persist in `.pi/goals/`. Goal state survives session compaction, workspace switches, and context churn.
- **Configurable settings** — Every persisted setting (task/contract toggles, subtask depth, auditor provider/model/thinking, auto-select, disable) is selectable and operable through `/goal-settings`; the file `.pi/pi-goal-x-settings.json` remains the durable store.

> **Fork of [@capyup/pi-goal](https://github.com/capyup/pi-goal)** — pi-goal-x is now maintained independently. It adds verification contracts, recursive task lists, multiple durable goals with session-local focus, an immutable objective, deferred archival, a configurable completion auditor, token budgets, compaction recovery, and a live progress widget.

## Install

From npm:

```bash
pi install npm:pi-goal-x
```

From a local checkout:

```bash
pi install .
```

Try once without installing:

```bash
pi -e .
```

## Quick start

### Regular goal

```text
/goal add structured logging to the auth module
```

Flow:

1. `/goal <seed>` begins a guided draft. The agent may ask focused questions
   or show a short questionnaire, and decides whether a task tree is useful.
2. The agent calls `propose_goal_draft` with the full objective and any task
   tree. The confirmation dialog presents both; Confirm creates them
   atomically, while Continue Chatting keeps the draft open for refinement.
3. The confirmed goal becomes this session's focus. Existing open goals remain
   in `.pi/goals/` and can be selected later with `/goal-focus`.
4. The agent works only on the focused goal until it requests completion via
  `update_goal`, reports a blocker, produces an empty/non-progress turn, or the
  user interrupts.

### Sisyphus goal

```text
/sisyphus Refactor the auth flow: 1) extract token validation. 2) wire it into login. 3) update tests.
```

Sisyphus mode is for patient ordered execution. It uses the same lifecycle and tools as a regular goal; the difference is the prompt style and completion standard: preserve the user's order, do not rush, do not invent preflight/reconnaissance steps, and stop to ask when blocked.

If the objective is already final, use `/goal-direct <objective>` or
`/sisyphus-direct <objective>` to create it immediately without drafting.

## User commands

The curated fourteen-command palette (each lifecycle action is independently
registered so tab completion is self-explanatory):

```text
/goal [seed]            Start a regular guided draft; bare form asks what to accomplish.
/sisyphus [seed]        Start a guided Sisyphus draft with ordered-work constraints.
/goal-direct <objective> Create and focus a regular goal immediately, without drafting.
/sisyphus-direct <objective> Create and focus a Sisyphus goal immediately, without drafting.
/goal-list              List all open goals in .pi/goals/ and the current focus
/goal-status            Show the focused goal and how many other goals are open (read-only)
/goal-focus             Choose this session's focused goal
/goal-unfocus           Stop this session's goal work without modifying the shared goal
/goal-tweak <change>    Guide a confirmed refinement of the focused objective and task plan
/goal-pause             Pause the focused active goal
/goal-resume            Resume a paused or blocked goal
/goal-settings          Configure pi-goal settings, including auditor model settings
/goal-clear             Archive the focused goal after confirmation
/goal-cancel            Cancel the in-progress guided draft without creating a goal
```

Pressing `Esc` or aborting an active run pauses the goal so it does not remain falsely active.

### Command migration

| Legacy command | New command |
|---|---|
| `/goal-status` | restored as the read-only focused-status command |
| `/goals-set <x>` | `/goal-direct <x>` |
| `/sisyphus-set <x>` | `/sisyphus-direct <x>` |
| `/goal-abort` | `/goal-clear` |
| `/goals <topic>` | `/goal <topic>` guided draft |

`/goal-tweak`, `/goal-pause`, `/goal-resume`, `/goal-clear`, `/goal-list`,
`/goal-focus`, `/goal-unfocus`, and `/goal-settings` are retained unchanged.

### Tool migration

| Legacy tool (removed) | Replacement |
|---|---|
| `complete_goal` | `update_goal({status: "complete"})` — audited from actual evidence, no verification-summary field |
| `pause_goal` | `/goal-pause` (user-owned); `update_goal({status: "paused"})` with a required reason for an immediate agent pause; `update_goal({status: "blocked"})` only after the same blocker recurs on three consecutive turns |
| `abort_goal` | `/goal-clear` (user-owned abandonment) |
| `propose_goal_draft` | Used only in the temporary guided draft entered by `/goal`, `/sisyphus`, or `/goal-tweak` |
| `propose_goal_tweak` | `/goal-tweak <change>` (a guided, user-confirmed revision) |
| `propose_task_list` | `set_goal_tasks` (structural, with confirmation) |
| `complete_task` / `skip_task` | `update_goal_task` (`complete`/`skipped`/`pending` on one task) |
| `step_complete` | Sisyphus completion is checked against the objective's numbered steps; no separate tool |
| `goal_question` / `goal_questionnaire` | Temporary guided-drafting tools; unavailable during normal execution |

Old goal-file and ledger readers (`readActiveGoalPool`, `readGoalLedger`,
`mergeGoalPromptFromDisk`, `latestAuditorResultForGoal`, `normalizeGoalRecord`)
remain so existing `.pi/goals/` files and ledgers stay readable.

## Multiple open goals and focus

`pi-goal` separates durable goals from session focus:

- **Goal pool**: every open goal is an `active_goal_*.md` file under `.pi/goals/`.
- **Focused goal**: the current pi session has one focused goal id stored in a `pi-goal-focus` custom session entry.
- **No focus in markdown**: goal files describe the goal itself; they do not record which session is focused on them.
- **Branch-local focus**: because focus is reconstructed from the current session branch, `/tree` navigation can restore a different focus for a different branch.
- **One continuation chain**: auto-continue only schedules work for the focused goal in the current session.

Confirming a `/goal` or `/sisyphus` draft, or using either `-direct` command, never clears other open goals; it creates a new active goal file and focuses it. Use `/goal-list` to inspect open goals, `/goal-focus` to switch the session focus, and `/goal-unfocus` to detach the current session without pausing, modifying, archiving, or recording a project-ledger focus change for the shared goal. Unfocus also aborts in-flight work and audits owned by that session; asynchronous lifecycle results are discarded if focus changed while they were pending. If the latest focus entry explicitly clears focus, or points at a missing/stale goal, a remaining single open goal is not auto-focused and resume does not prompt to replace that explicit choice. By default (`autoSelectSingleGoal: false`) sessions start unfocused so focus stays session-scoped — useful when multiple sessions share the same `.pi/goals/` directory. Set `autoSelectSingleGoal: true` to restore the old behavior where a single open goal is auto-focused when no focus entry exists at all. If multiple open goals exist and the session has no valid focus, `/goal-resume`, `/goal-clear`, `/goal-pause`, and `/goal-tweak` ask the user to choose a goal instead of acting on all of them.

## Agent tools

Normal execution uses a fixed five-tool profile (three core tools when tasks
are disabled). It is installed at session start and after a `disableTasks`
setting change; focus, status, budget, completion, audit, and compaction do
not change it. The only exception is a user-started draft: it temporarily
replaces the goal tools with `goal_question`, `goal_questionnaire`, and
`propose_goal_draft`, then restores execution tools on confirmation or exit.

| Tool | Purpose |
|---|---|
| `create_goal` | Create and focus a new goal after an explicit user request (objective 1–4000 chars, optional `mode` regular/sisyphus and `token_budget`). Never infer a goal from an ordinary task. |
| `get_goal` | Read-only complete focused goal snapshot: objective, status, mode, usage, budget + remaining, task summary, verification contract, blocker details, paths, other-open count. |
| `update_goal` | Report a run outcome: `complete` (runs the independent auditor, which verifies from actual evidence; an optional `completion_summary` is an untrusted claim, never evidence), `blocked` (distinct agent-blocked state, only after the same blocker recurs on three consecutive turns), or `paused` (immediate agent pause with a required `reason` and optional `suggested_action`). |
| `set_goal_tasks` | Create or structurally replace the task tree (flat parent-linked input, confirmation dialog, matching ids keep status/evidence). |
| `update_goal_task` | Update one task without stopping the turn: complete (evidence for contracted tasks), skipped (reason), pending (reopens skipped). |

During a user-started draft, these replace the execution tools:

| Tool | Purpose |
|---|---|
| `goal_question` | Ask one focused structured clarification question. |
| `goal_questionnaire` | Ask a small multi-question questionnaire. |
| `propose_goal_draft` | Present the complete objective and the agent-selected flat task tree for Confirm, Continue Chatting, or Cancel. |

Plus ordinary Pi work tools, which the extension never adds, removes, or
force-enables: the user's host-tool selection is preserved. Lifecycle actions
the model does not own (pause, resume, clear, focus, tweak, settings) are
user-owned slash commands. When `disableTasks` is enabled, only the three core
tools are advertised.

## Goal creation

`/goal [seed]` and `/sisyphus [seed]` begin a goal-specific drafting state.
The agent can clarify intent in conversation, use `goal_question` or
`goal_questionnaire` when structured answers help, and choose a task tree
when the work naturally decomposes. `propose_goal_draft` displays the full
goal and task proposal for explicit Confirm or Continue Chatting. Only Confirm
persists and focuses the goal. `/goal-direct <objective>` and
`/sisyphus-direct <objective>` are the explicit no-drafting alternatives.
During a draft `create_goal` is not advertised; it remains the normal
execution-surface tool for an explicit user request outside drafting.

The model may do minimal read-only reconnaissance before creating a goal, but
should not begin substantive implementation before the goal exists. When a
goal is created, the tool result includes the full final objective and the
normal work tools (`write`, `read`, `bash`, `edit`) are available for
execution.

## Completion behavior

Completion is explicit and checked by an independent pi auditor agent. The
model calls `update_goal` with the terminal outcome:

```json
{ "status": "complete", "completion_summary": "optional untrusted claim" }
```

There is no paperwork field: the auditor derives the requirements from the
objective and any verification contract, and inspects the actual workspace
evidence (including the task tree and its evidence). An optional
`completion_summary` reaches the auditor as an UNTRUSTED claim — it is never
evidence and cannot make a disapproved goal complete. `update_goal` accepts
`complete`, `blocked`, or `paused` (with a required `reason`).

Before archiving the goal, completion starts a separate pi agent in an isolated
in-memory session. The auditor receives the objective, mode, verification
contract, task tree and task evidence, current usage/budget, and the workspace
path with read-only-oriented tools (`read`, `grep`, `find`, `ls`, `bash`). It
must end its report with exactly one marker:

- `<approved/>` archives the goal as complete.
- `<disapproved/>`, no marker, an error, or an abort rejects completion and
  leaves the goal open with the auditor feedback recorded.

The auditor is semantic, not a paperwork checklist: it should reject
scaffold-only, alpha, generated-template, proxy-metric, build-only, or weakly
verified completions when the real user outcome is not satisfied.

By default the auditor uses the current/default pi model. Configure it via
`.pi/pi-goal-x-settings.json`, or interactively with `/goal-settings`.

`blocked` records a distinct agent-blocked state and stops continuation. To
align with Codex behavior, the tool description and continuation prompt require
the same blocker to recur on three consecutive goal turns before the model
reports blocked; there is no separate attempt counter. A user pause
(`/goal-pause`, Esc) remains an immediate, distinct state, and the agent can
pause immediately with `update_goal({status: "paused"})` plus a reason. The
model cannot abort a goal — obsolete or abandoned goals are cleared by the user
through `/goal-clear`.

Sisyphus goals use the same lifecycle tools as regular goals; the difference is
the prompt/criteria execution standard. A paused goal can also be completed
directly when the agent already has enough evidence that every requirement is
satisfied.

## Schema gates

The shipped gates are intentionally small and mechanical.

| Gate | Prevents |
|---|---|
| Objective bound | `create_goal` / `/goal` objectives outside 1–4000 characters |
| Explicit request | The model inferring a goal from an ordinary task (prompt policy) |
| Completion auditor gate | Archiving completion unless an independent pi auditor agent returns `<approved/>` |
| Blocked-from-active | `update_goal(blocked)` on a non-active goal |
| Task schema gates | set_goal_tasks flat-input validation (ids, parents, acyclic, ≤50, depth, lightweight placement); update_goal_task evidence/reason/status rules |
| Post-stop block | Continuing to call tools after `update_goal` / `set_goal_tasks` / a user lifecycle command stops the turn |
| Empty-turn guard | Pure chat loops that would keep auto-continuing without meaningful goal work |
| Abort pause | Active goals staying active after user abort / Ctrl-C |
| Disk reconciliation | External pause/archive/delete/status changes being ignored or overwritten by stale memory |
| Post-compaction reminder | Losing the active objective after session compaction |
| Budget transition | Accounted usage crossing the token budget firing more than once |

## Files

```text
.pi/goals/active_goal_<timestamp>_<id>.md
.pi/goals/archived/goal_<timestamp>_<id>.md
```

Multiple `active_goal_*.md` files may exist simultaneously. This is the project-level open goal pool. The selected/focused goal is intentionally not stored in these files; focus lives in session custom state.

Each file contains:

1. extension-owned JSON metadata;
2. a user-editable `# Goal Prompt` section;
3. progress/status information.

Before commands, tools, and lifecycle hooks act on a focused goal, the runtime reconciles the focused record against the active goal file on disk. External archive/delete/status changes therefore win over stale in-memory state and cannot resurrect deleted active files. Prompt-body edits are still picked up from the `# Goal Prompt` section; focus is never stored in goal markdown.

Goal paths are constrained to `.pi/goals/` and `.pi/goals/archived/`; absolute paths, traversal, NUL bytes, symlinks, and unsafe metadata paths are rejected.

## Configuration

All settings live in a single file: **`.pi/pi-goal-x-settings.json`**

All eight persisted fields are selectable and operable through
`/goal-settings`: booleans toggle directly, `provider`/`model` edit and clear,
`thinkingLevel` accepts every level and rejects unknown values, and
`subtaskDepth` validates the full input string (whole positive safe integers
only). The file remains the durable store and env-var overrides take
precedence.

```json
{
  "disableTasks": false,
  "disableContracts": false,
  "subtaskDepth": 1,
  "autoSelectSingleGoal": false,
  "provider": "fireworks",
  "model": "accounts/fireworks/models/deepseek-v4-flash",
  "thinkingLevel": "high",
  "disabled": false
}
```

| Field | Default | `/goal-settings` | Purpose |
|---|---:|:---:|---|
| `disableTasks` | `false` | Yes | Suppress task list features entirely when `true` |
| `disableContracts` | `false` | Yes | Suppress verification contract enforcement when `true` |
| `subtaskDepth` | `1` | Yes | Maximum nesting depth for subtasks (whole positive integers only) |
| `autoSelectSingleGoal` | `false` | Yes | When `true`, auto-focus the single open goal when a session has no focus entry (default keeps goals session-scoped) |
| `provider` | system default | Yes | Provider name for the auditor agent |
| `model` | system default | Yes | Model name for the auditor agent |
| `thinkingLevel` | system default | Yes | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `disabled` | `false` | Yes | When `true`, skips the completion audit: `update_goal({status:"complete"})` records an `audit_skipped` event and completes through the normal deferred-completion path. |

**Env var overrides:**
- `PI_GOAL_DISABLE_TASKS=1` — disable task features (takes precedence over file)
- `PI_GOAL_DISABLE_CONTRACTS=1` — disable contract enforcement (takes precedence over file)
- `PI_GOAL_SETTINGS_FILE=custom-path.json` — alternative settings file path (relative to cwd or absolute)

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PI_GOAL_AUTO_CONFIRM` | unset | When `1`, auto-confirms task-list proposals in headless/test contexts |
| `PI_GOAL_DISABLE_TASKS` | — | When `1`, disable task features (overrides settings file) |
| `PI_GOAL_DISABLE_CONTRACTS` | — | When `1`, disable contract enforcement (overrides settings file) |
| `PI_GOAL_SETTINGS_FILE` | `.pi/pi-goal-x-settings.json` | Alternative settings file path (relative to cwd or absolute) |

## Development

```bash
npm install
npm test
npm run check
npm pack --dry-run
```

The unit and integration commands discover `*.test.ts` files automatically and
run them in one Node process. Test-only adapters provide the small runtime SDK
surface the handlers exercise, avoiding initialization of unrelated Pi model
providers and TUI media modules. `npm run test:all` runs all 510 cases in one
startup; `npm run test:selfcheck` asserts the discovered test entries match the
pinned manifest. The fast runner requires Node 22.15 or newer (for synchronous
module hooks); on older supported development environments, use `test:serial`.
The suite covers records/storage,
lifecycle policy, the service/runtime/accounting split, the five tool handlers,
the fourteen commands, tasks/contracts, auditing, drafting, compaction,
prompts, widgets, and the experiment harness.
Use `npm run test:serial` as the real-SDK, process-isolated compatibility path.
The handler-level
integration suite (`npm run test:integration`, part of `test:all`) drives the
actual registered tools with an auditor fixture; the legacy `tests/e2e/run.ts`
real-model runner is manual and opt-in.

The experiment harness under `experiments/` runs full pi sessions against real
model calls and mechanical rubrics. C20-C26 are the release evaluation set;
B1-B2 and C1-C19 have also been migrated to the five-tool interface. Experiments are
opt-in because they incur model usage.

```bash
cd experiments
bash harness/run.sh C1-vague-goal-set --count 3 --grade --no-smoke
```

## Package contents

The npm package ships only the runtime extension, docs, and package metadata. The extension is split into small modules:

```text
extensions/goal.ts                 thin installer for renderers, commands, tools, and events
extensions/goal-state.ts           shared GoalCore state and service/runtime wiring
extensions/goal-tools.ts           tool registration composition (core + task installers)
extensions/goal-core-tools.ts      create_goal / get_goal / update_goal executors, and the blocked and agent-pause flows
extensions/goal-completion.ts      completion transaction (audit orchestration + commit)
extensions/goal-task-tools.ts      set_goal_tasks / update_goal_task executors, flat conversion, merge, counts
extensions/goal-task-confirmation.ts task-only result boundary ({decision}) with neutral Confirm task list / Keep current tasks labels
extensions/goal-commands.ts        fourteen slash-command handlers
extensions/goal-events.ts          lifecycle event handlers
extensions/goal-service.ts         ordered goal mutation boundary (incl. typed updateTask transaction)
extensions/goal-runtime.ts         continuation, stale-checkpoint, and turn-stop state
extensions/goal-accounting.ts      idempotent usage accounting and budget helpers
extensions/goal-format.ts          result formatting and message introspection
extensions/goal-record.ts          goal record types, normalization, creation helpers
extensions/goal-contract.ts        verification-contract extraction and objective prompt-safety
extensions/goal-pool.ts            open-goal pool, focus resolution, list/selector text helpers
extensions/goal-core.ts            display helpers
extensions/goal-policy.ts          lifecycle, completion, task, and compaction policy
extensions/goal-auditor.ts         independent pi auditor agent for completion approval, config, and progress tracking
extensions/goal-ledger.ts          event append, read, validation, sanitization, and reconstruction (task_reopened)
extensions/goal-draft.ts           drafting prompt/confirmation text helpers and Sisyphus sufficiency guidance
extensions/goal-drafting.ts         guided drafting orchestration (durable draft sessions, questionnaire tools, propose_goal_draft)
extensions/goal-questionnaire.ts    structured question/answer UI used by the drafting tools and confirmation dialogs
extensions/goal-tool-names.ts      the five published names, fixed profiles, work/progress sets, post-stop allowlist
extensions/prompts/goal-prompts.ts active, continuation, stale, unfocused, and budget prompts
extensions/storage/goal-files.ts   goal file paths, serialization, parsing, archive IO
extensions/widgets/goal-widget.ts  above-editor goal beacon component
extensions/widgets/goal-notifications.ts widget-style notification text
```

## Design principles

- **User owns mutable intent**: the user controls objective changes, pause/resume, clear, focus, settings, and cancellation; the agent may create only on explicit request and may report complete, blocked, or paused (with a reason) outcomes.
- **Guided creation with an explicit direct bypass**: `/goal` and `/sisyphus` always run the guided draft (clarify, propose, confirm); `/goal-direct` and `/sisyphus-direct` are the explicit no-drafting paths.
- **Schema beats prompt walls**: recurring failure modes are handled by validators and tool-call interceptors.
- **Visible contracts**: created goals and completion reports are printed fully into the conversation.
- **Small stable target surface**: three core model tools plus two task tools; lifecycle validity belongs in handlers, not phase-specific tool rebuilding.
- **Disk-backed continuity**: goal state survives context churn and can be audited from `.pi/goals/`.
- **Human-owned focus**: the agent may work on the focused goal, but only user commands/UI selection switch focus.

## Hardening

The 2026-08-04 hardening pass
([`specs/2026-08-04-goal-simplification-hardening`](specs/2026-08-04-goal-simplification-hardening/PRODUCT.md))
is implemented and validated: persisted lifecycle status is
authoritative (paused stays paused, including legacy `autoContinue: true`
records), disabled-auditor completion works and records `audit_skipped`, the
three/five tool profile is fixed and host tools are never touched, task
operations are disk-fresh transactions with structural-clearing merge
semantics, `token_budget` is a positive safe integer, reopening a task writes
`task_reopened`, and ledger failures surface through an observable diagnostic.

### Runtime follow-up (current branch)

The 2026-08-04 follow-up
([`specs/2026-08-04-goal-runtime-follow-up`](specs/2026-08-04-goal-runtime-follow-up/PRODUCT.md))
landed the remaining work:

- The settings menu is fully operable (all eight persisted fields, exact
  `subtaskDepth` validation, correct repeated task toggles).
- `/goal-clear` asks for confirmation (cancel is a byte-for-byte no-op);
  task-list confirmation uses neutral labels; an aborted audit produces one
  canonical ledger event and continue-working leaves the goal active.
- Completion commits are failure-checked transactions.
- Cross-process mutations are serialized with persisted revisions and
  per-goal locks (typed conflicts, no blind overwrites).
- **Guided drafting is restored as a first-class workflow** (a product
  correction reversing the interim removal): `/goal`, `/sisyphus`, and
  `/goal-tweak`
  run a transient draft with `goal_question`, `goal_questionnaire`, and
  `propose_goal_draft` (Confirm / Continue / Cancel); durable draft sessions
  survive compaction; `/goal-cancel` and `/goal-status` complete the
  fourteen-command palette; per-draft auditor selection persists on create
  and tweak; the agent can pause with a reason, abandonment stays
  user-owned via `/goal-clear`, and `completion_summary` is an untrusted
  auditor claim.
- The experiment harness enforces `SUPPORTED_CASES.json`, uses the selected
  model in the smoke check, and runs on portable timeouts; the test runner
  has a self-check; the Pi SDK family is upgraded to 0.83 with both
  dependency audits clean.

## Relationship to pi-goal

pi-goal-x started as a fork of [@capyup/pi-goal](https://github.com/capyup/pi-goal), but it is maintained as an independent project with a single `origin` remote at `github.com/tmonk/pi-goal-x`. Bug reports, feature requests, and contributions target this repository directly.

## Release policy

This repository can be validated locally with tests and packaging checks. Publishing a new npm version, pushing tags, and running `pi update` are explicit release steps and are not part of ordinary implementation goals unless requested.

## License

MIT
