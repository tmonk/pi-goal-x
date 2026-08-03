# Technical Plan: Goal simplification hardening

## 1. Delivery order

Implement in dependency order so each stage has an independently testable
contract:

1. lifecycle and auditor correctness;
2. fixed tool profile;
3. task transaction correctness;
4. schema and ledger cleanup;
5. remove drafting-era runtime code;
6. repair tests and experiments;
7. final documentation and release validation.

## 2. Lifecycle and auditor correctness

### 2.1 Status-authoritative normalization

In `extensions/goal-record.ts`:

- replace the mutable `status` local with a direct exhaustive normalization;
- delete the `paused && autoContinue => active` migration;
- normalize `autoContinue` independently;
- normalize `tokenBudget` with a shared positive-safe-integer helper.

Add record and storage regressions for all five statuses with both continuation
flag values. Include the exact legacy case `{status:"paused",
autoContinue:true}` through markdown parse and session restore, not only the
pure normalizer.

### 2.2 Disabled-auditor completion

In the completion flow:

- remove `completionSummary`, `verificationSummary`, `confirmBypassAuditor`,
  and redundant `status` from the internal options type;
- use one helper for all successful completion commits, whether audit-approved,
  globally disabled, legacy per-goal skipped, or user-bypassed;
- treat `settings.disabled === true` as authorization to skip immediately;
- append `completion_requested`, `audit_skipped`, then deferred completion in
  the same semantic order;
- retain focus-revision validation before the state write.

Add integration tests for global disabled, legacy per-goal skip, audit
approval, rejection, aborted audit, and focus changed during audit. Assert that
the public schema has only `status`.

## 3. Fixed three/five tool profile

Replace `syncGoalTools()` with a narrow `installGoalToolProfile()`:

```ts
function installGoalToolProfile(tasksEnabled: boolean): void {
  const current = new Set(pi.getActiveTools());
  for (const knownGoalTool of ALL_REGISTERED_GOAL_TOOLS) {
    current.delete(knownGoalTool);
  }
  for (const goalTool of tasksEnabled ? FIVE_GOAL_TOOLS : CORE_GOAL_TOOLS) {
    current.add(goalTool);
  }
  pi.setActiveTools([...current]);
}
```

Call it only after extension/session initialization and after a settings change
that toggles `disableTasks`. Delete lifecycle calls from commands, events,
tools, runtime hooks, widget handlers, persistence helpers, and focus changes.
Do not add `read`, `write`, `edit`, `bash`, or any other host tool.

Keep authoritative validation in every executor:

- `create_goal`: explicit-request prompt policy plus objective/schema checks;
- `get_goal`: valid with or without focus;
- `update_goal`: returns a state-aware failure with no completable/active goal;
- `set_goal_tasks`: active or paused only;
- `update_goal_task`: active goal with an existing task list only.

Rewrite visibility tests as invariance tests. Seed arbitrary host tool sets and
assert that lifecycle changes do not change either the goal profile or the host
selection.

## 4. Transaction-safe task operations

### 4.1 Confirmation boundary

Extract a task-only confirmation component with `{decision}` as its complete
result. Remove the auditor checkbox and all `skipAuditor` mutation from
`set_goal_tasks`. Pass the confirmed structural input into `GoalService.apply`
and merge it against the clone supplied to `mutate` after disk refresh.

### 4.2 Disk-fresh mutation

For `update_goal_task`, move `findTaskInTree`, validation that depends on task
state, and `updateTaskInTree` into the `mutate` callback or introduce a typed
`GoalService.updateTask` transaction. The transaction should:

1. reconcile the focused record;
2. validate focus token/id;
3. load the fresh task from the cloned disk record;
4. validate the requested transition;
5. update only that task path;
6. write, ledger, and commit.

Return typed validation failures rather than throwing for expected races such
as a removed task or task list.

### 4.3 Structural merge semantics

Change `mergeTasksWithExisting` so only progress fields are copied from a
matching prior task. Assign incoming structural fields directly, including
`undefined`, so omission clears them. Count all nodes with one shared
`countTasks()` helper for results and ledger events.

Add tests for clearing a contract/flag, moving a task between parents,
deleting children, preserving completed evidence, and an external task edit
between confirmation and apply.

## 5. Schema and ledger cleanup

### 5.1 Token budget

- use `Type.Integer({minimum: 1})` for `token_budget`;
- runtime-check `Number.isSafeInteger` because tool callers are untrusted;
- share validation between slash-command parsing, tool execution, record
  creation, and persisted normalization;
- reject invalid live input with a user-facing message; treat invalid legacy
  persisted values as absent.

### 5.2 Ledger vocabulary and diagnostics

- add `{type:"task_reopened", goalId, taskId, at}`;
- update validation, sanitization, reconstruction, golden fixtures, compaction
  summaries, and docs;
- retain backwards reading of the old synthetic `task_skipped` unskip reason;
- add `onDiagnostic(diagnostic)` to `GoalServiceRef`, or return diagnostics in
  `GoalMutationResult`; route all ledger append failures through it;
- make `appendGoalEvent` return a discriminated result instead of swallowing
  both append attempts internally.

Do not roll back an authoritative state write after a ledger failure. Surface a
warning in debug/UI logs and make failure injection testable.

## 6. Remove drafting-era runtime coupling

### 6.1 Tool names and policy

Reduce `goal-tool-names.ts` to the five public constants, fixed profiles,
work/progress classification for those tools, and post-stop allowlist. Delete:

- legacy tool constants and `LEGACY_TASK_TOOL_NAMES`;
- `GoalToolPhase` and `lifecycleToolNamesForGoalStatus`;
- question-like name heuristics;
- compatibility arrays that are only asserted by obsolete tests.

Split reusable helpers out of legacy modules before deleting them:

- move verification-contract extraction to a small record/input parser;
- move task confirmation UI to a task-specific module;
- delete question-tool registration and draft proposal code;
- remove obsolete abort/pause/completion-summary policy builders.

### 6.2 Module boundaries

`goal-tools.ts` currently owns registration, completion/audit orchestration,
blocked flow, task confirmation, and task mutation. Split it into:

- `goal-tools.ts`: registration composition only;
- `goal-core-tools.ts`: create/get/update executors;
- `goal-completion.ts`: audit and successful completion transaction;
- `goal-task-tools.ts`: task schemas/executors and flat conversion;
- `goal-task-confirmation.ts`: task-only UI.

Target roughly 300-450 lines per behavior module and keep pure conversion
helpers separately testable. This is a maintainability target, not a hard
runtime invariant.

## 7. Test and experiment repair

### 7.1 Local suites

- delete or rewrite source-string tests that preserve old tool names;
- replace simulated storage E2E tests with handler-level fixtures using the
  actual registered tools and service;
- move supported `tests/e2e/extension.test.ts` into the normal test glob or add
  an explicit `test:integration` script included by `test:all`;
- rewrite/remove `tests/e2e/run.ts`, chain, and runner instructions so they use
  `update_goal({status:"complete"})` and a real auditor fixture rather than a
  removed bypass field;
- divide pure unit tests from extension integration tests to reduce repeated
  heavy module startup and diagnose the current long serial runtime;
- keep serial mode available for low-file-descriptor environments.

Suggested scripts:

```json
{
  "test:unit": "node --experimental-strip-types --test tests/*.test.ts",
  "test:integration": "node --experimental-strip-types --test --test-concurrency=1 tests/integration/*.test.ts",
  "test:all": "npm run test:unit && npm run test:integration"
}
```

### 7.2 Real-model experiments

- declare the 2026-08-03 Stage 0 baseline historical;
- migrate C1-C19 to direct `/goal`/`/sisyphus`, the five tools, and user-owned
  lifecycle, or move them to `experiments/legacy/` and exclude them from the
  supported matrix;
- verify C20-C26 harness setup actually exposes the fixed five-tool profile;
- ensure removed names appear only in negative rubric assertions;
- publish a machine-readable supported case list so `run.sh all` cannot
  accidentally execute historical cases.

Real-model experiments are release gates but remain manual/opt-in.

## 8. Documentation closure

Update living docs after behavior lands:

- package description and README feature/config/development/module sections;
- `docs/architecture.md` and `docs/agent-flow-design.md` from verified code;
- experiment README/PLAN and E2E instructions;
- current spec status and MILESTONES validation evidence.

Historical documents retain original content with a banner stating the date,
superseding spec, and that names/flows are not current API documentation.

## 9. Validation matrix

Required local checks:

```bash
npm run check
npm run test:all
npm pack --dry-run
git diff --check
```

Targeted regression matrix:

| Area | Required cases |
|---|---|
| Tool profile | no focus; active; paused; blocked; budget; complete; task-disabled; settings reload |
| Lifecycle | paused legacy restore; user pause/resume; blocked/resume; deferred complete/archive |
| Audit | approved; rejected; disabled setting; legacy skip; user abort; focus race |
| Tasks | set/replace/clear structure; complete/skip/reopen; external-edit race; task disabled |
| Budget | integer boundary; invalid live values; invalid legacy values; one-shot transition |
| Persistence | multi-goal pool; focus branch; external edit/delete/archive; ledger failure |
| Compatibility | old v3 records and all historical ledger event types |

Before release, run C20-C26 at least three times on the supported model matrix
and record pass rates and failures in `MILESTONES.md`.

## 10. Rollback

Keep each stage in a separate commit. If fixed-profile installation exposes a
host compatibility issue, revert that stage without reverting lifecycle and
audit correctness. Do not restore removed public tools; a rollback may return
temporarily to dynamic visibility only while preserving the five registered
names.

