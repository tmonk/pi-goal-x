# Product Spec: Goal simplification hardening

## Summary

The Codex-inspired interface has landed, but the implementation does not yet
fully satisfy its public contract. This hardening pass makes the five model
tools genuinely stable, fixes lifecycle and completion regressions, removes
the remaining drafting-era coupling, and brings the test and documentation
surfaces into line with the shipped product.

The product remains deliberately richer than Codex Goal mode: multiple open
goals, session-local focus, task trees, contracts, independent auditing,
Sisyphus mode, accounting, continuation, compaction recovery, the ledger, and
the widget all remain.

## Problems found in implementation review

### Critical behavior gaps

1. A persisted `paused` goal with legacy `autoContinue: true` is normalized
   back to `active`. Persisted lifecycle status must be authoritative.
2. Setting `disabled: true` for the auditor makes `update_goal(complete)`
   impossible because the only bypass flag was removed from the public tool
   schema but is still required internally.
3. Task updates calculate a replacement tree before the service refreshes the
   record from disk. A concurrent external edit can therefore be overwritten
   by stale in-memory task state.

### Interface and ownership gaps

4. The five tools are registered, but the advertised subset is still rebuilt
   on nearly every state transition. `update_goal` and task tools disappear by
   phase, and the synchronizer also force-enables Pi work tools. This violates
   the stable-surface contract and makes extension correctness depend on host
   tool state.
5. Task-list confirmation still exposes an auditor toggle inherited from goal
   confirmation. It mutates `core.state.goal.skipAuditor` outside
   `GoalService`, coupling an unrelated task edit to completion policy.
6. Removed tool constants, drafting phases, question-tool heuristics, proposal
   helpers, and compatibility signatures remain in active runtime modules and
   tests. They increase cognitive and regression surface without providing a
   supported compatibility path.

### Data and contract gaps

7. `token_budget` is described as whole tokens but accepts fractional numbers;
   persisted normalization also retains zero as a budget.
8. Replacing a task tree cannot clear an existing verification contract or
   `lightweightSubtasks` flag when a matching id omits those optional fields.
9. Reopening a task writes a second `task_skipped` event instead of a semantic
   reopen event, and task-list ledger counts only root tasks.
10. Ledger failures are documented as visible diagnostics but are silently
    swallowed.

### Quality-system gaps

11. The supported unit suite does not execute `tests/e2e/`; that runner and its
    manual instructions still call removed tools and fields.
12. The C1-C19 experiment cases and experiment guide mostly describe the old
    drafting/lifecycle interface. Current documentation presents them as a
    valid current suite.
13. Living documentation mixes the intended architecture, current behavior,
    and historical design records, producing contradictions about tools,
    commands, storage, and audit behavior.

## Product decisions

### Stable model surface

- Register exactly the five goal tools for the session when tasks are enabled:
  `create_goal`, `get_goal`, `update_goal`, `set_goal_tasks`, and
  `update_goal_task`.
- Register exactly the three core tools when tasks are disabled.
- Do not add, remove, or restore tools based on focus or goal status.
- Do not change Pi's ordinary work-tool selection. Invalid lifecycle calls are
  rejected by the tool handler with a concise state-aware result.
- A settings change that toggles task support may update the fixed three/five
  goal-tool profile once; lifecycle transitions may not.

### Lifecycle authority

- Persisted `status` is authoritative. `autoContinue` is an execution
  preference and must never rewrite status during reads or migration.
- Effective continuation requires both `status === "active"` and
  `autoContinue === true`.
- Existing paused records remain paused, including legacy records with a stale
  true continuation flag.

### Audit ownership

- Global `disabled: true` is an explicit user-owned setting and causes
  completion to skip the auditor, record `audit_skipped`, and proceed through
  the normal deferred-completion path.
- Remove the auditor toggle from task-list confirmation.
- Existing persisted `skipAuditor: true` records remain readable and honored
  for compatibility, but no model tool or unrelated task dialog creates new
  per-goal bypass state.
- Escape during a running audit remains the explicit per-attempt user bypass.

### Task replacement and updates

- Matching task ids preserve runtime progress only: status, evidence,
  completion/skip timestamps, and skip reason.
- Incoming structural fields are authoritative: title, verification contract,
  lightweight flag, parentage, and child structure. Omitting an optional
  structural field clears it.
- Per-task mutations locate and update the task inside the disk-refreshed clone
  passed to `GoalService.mutate`; they never install a tree calculated from an
  earlier record.
- Reopening writes `task_reopened`. Task-list counts include all nodes.

### Schema and storage clarity

- `token_budget` is a positive safe integer in both schema and runtime.
- Invalid persisted budgets (non-finite, fractional, zero, negative, or unsafe)
  normalize to absent rather than silently changing meaning.
- Ledger append failures remain non-fatal after the authoritative state write,
  but produce an observable diagnostic through a single service hook.

### Documentation and validation

- README, package metadata, architecture, agent-flow, experiment, and E2E
  documentation describe the current supported API only.
- Superseded design documents carry an explicit historical banner and a link to
  this living spec; they are not rewritten as if their original decisions had
  always been different.
- The supported validation command runs unit and extension integration tests.
  Real-model experiments remain opt-in because they incur model cost.
- C1-C19 are either migrated to the five-tool interface or moved under an
  explicitly unsupported historical baseline. C20-C26 remain the release
  evaluation set and must be executable by the harness.

## Success criteria

1. The advertised goal-tool set remains exactly three or five across no-focus,
   active, paused, blocked, budget-limited, complete, audit, compaction, and
   focus transitions.
2. Tool-profile installation never enables or disables ordinary Pi tools.
3. A paused record with `autoContinue: true` stays paused after every read and
   session restore.
4. `disabled: true` completion succeeds without a model-only bypass field and
   records an audit-skip event.
5. Task-list confirmation cannot modify audit settings or goal state outside
   the service.
6. Concurrent disk task changes are preserved unless the requested operation
   changes the same task.
7. Structural replacement can remove contracts, lightweight flags, and child
   links while retaining matching-id progress.
8. Fractional, zero, negative, infinite, and unsafe budgets are rejected or
   normalized absent as appropriate.
9. The active runtime contains no removed model-tool constants, drafting phase
   types, or obsolete completion parameters.
10. All living docs, package metadata, test instructions, and experiment guides
    agree on the ten commands, five tools, single ledger path, and current
    lifecycle.
11. Type checking, the complete local test suite, package dry-run, and diff
    checks pass. C20-C26 pass the real-model gate before release.

## Non-goals

- Collapsing to one tool.
- Removing tasks, contracts, audit, multi-goal focus, Sisyphus mode, the
  ledger, accounting, continuation, compaction recovery, settings, or widgets.
- Making the model owner of pause, resume, clear, focus, tweak, or settings.
- Rewriting old goal files or ledgers solely for migration.
- Running paid real-model experiments automatically in `npm test`.

