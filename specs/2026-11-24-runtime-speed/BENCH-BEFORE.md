# Benchmark baseline — before

Generated 2026-11-24T15:10:23.061Z · agent-free (B8) · local machine numbers (p50/p95/max, ms unless noted).

Fixture sizes and storage classes are per row. The next run re-emits this file as `BENCH-AFTER.md` and the B6 gate diffs the two.

| id | label | modules | fixture | ops | n | p50 ms | p95 ms | max ms | latency | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| B1.settings.present | settings load (file present) | goal-settings | 1 settings file | 0 | 200 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B1.settings.present.lat25 | settings load (file present, +25ms/op) | goal-settings | 1 settings file | 0 | 100 | 0 | 0 | 1.6 | 25ms/op | mean 0ms |
| B1.settings.missing | settings load (file missing) | goal-settings | no file | 0 | 200 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B1.pool.1g | pool scan (1 goal) | storage/goal-files | 1 active goal files | 0 | 30 | 0 | 0 | 0 | 0ms | mean 0ms |
| B1.pool.1g.lat25 | pool scan (1 goal, +25ms/op) | storage/goal-files | 1 active goal files | 0 | 10 | 0 | 0 | 0 | 25ms/op | mean 0ms |
| B1.pool.10g | pool scan (10 goals) | storage/goal-files | 10 active goal files | 0 | 30 | 0 | 0 | 0 | 0ms | mean 0ms |
| B1.pool.10g.lat25 | pool scan (10 goals, +25ms/op) | storage/goal-files | 10 active goal files | 0 | 10 | 0 | 0 | 0 | 25ms/op | mean 0ms |
| B1.pool.50g | pool scan (50 goals) | storage/goal-files | 50 active goal files | 0 | 30 | 0 | 0 | 0 | 0ms | mean 0ms |
| B1.pool.50g.lat25 | pool scan (50 goals, +25ms/op) | storage/goal-files | 50 active goal files | 0 | 10 | 0 | 0 | 0 | 25ms/op | mean 0ms |
| B1.ledger.1k | ledger full parse (1k events) | goal-ledger | 1000 ledger events | 0 | 20 | 0 | 0 | 0 | 0ms | mean 0ms |
| B1.ledger.1k.lat25 | ledger full parse (1k, +25ms/op) | goal-ledger | 1000 ledger events | 0 | 5 | 0 | 0 | 0 | 25ms/op | mean 0ms |
| B1.lock.uncontended | lock acquire+release (uncontended) | storage/goal-lock | fresh lock dir | 4 | 50 | 0 | 0.1 | 0.1 | 0ms | mean 0.1ms |
| B1.append.single | ledger append (single event) | goal-ledger | 1k-event ledger file | 1 | 50 | 0 | 0.1 | 2.5 | 0ms | mean 0.1ms |
| B1.append.x4 | ledger append x4 (batched, one write) | goal-ledger | 1k-event ledger file | 1 | 20 | 0 | 3.1 | 4.3 | 0ms | mean 0.6ms; one appendFileSync for 4 events (was 4×5 ops) |
| B3.parse.1000 | ledger full parse (1000 events) | goal-ledger | 1000 events | - | 10 | 0 | 0 | 0 | 0ms | mean 0ms |
| B3.reconstruct.1000 | ledger reconstruction (1000 events) | goal-ledger | 1000 in-memory events | - | 30 | 0.3 | 0.3 | 2 | 0ms | mean 0.3ms |
| B3.parse.5000 | ledger full parse (5000 events) | goal-ledger | 5000 events | - | 10 | 0 | 0 | 0 | 0ms | mean 0ms |
| B3.reconstruct.5000 | ledger reconstruction (5000 events) | goal-ledger | 5000 in-memory events | - | 30 | 0.6 | 1 | 3.4 | 0ms | mean 0.8ms |
| B3.parse.10000 | ledger full parse (10000 events) | goal-ledger | 10000 events | - | 10 | 0 | 0 | 0 | 0ms | mean 0ms |
| B3.reconstruct.10000 | ledger reconstruction (10000 events) | goal-ledger | 10000 in-memory events | - | 30 | 1.3 | 2.2 | 4.4 | 0ms | mean 1.5ms |
| B2.readturn.1g | per-turn read pipeline (1 goal, 1k ledger) | goal-settings + storage/goal-files + goal-ledger + prompts/goal-prompts | 1 goals, 1000 events | 0 | 20 | 0 | 3.4 | 3.4 | 0ms | fs ops/turn 0 (p50), mean 0.2ms |
| B2.readturn.10g | per-turn read pipeline (10 goals, 1k ledger) | goal-settings + storage/goal-files + goal-ledger + prompts/goal-prompts | 10 goals, 1000 events | 0 | 20 | 0 | 2.6 | 2.6 | 0ms | fs ops/turn 0 (p50), mean 0.1ms |
| B2.mutationturn.task | per-turn mutation (one update_goal_task) | goal-task-tools + goal-service + storage/goal-files + goal-ledger + storage/goal-lock | 1 goal, 1 task | 24 | 1 | 3.4 | 3.4 | 3.4 | 0ms | fs ops for one task mutation: 24 (P1-3 batches to one lock+write+append) |
| B4.taskListBlock.10t | taskListBlock (10-task tree) | prompts/goal-prompts | 10 tasks (half complete, contracts+evidence) | 171 | 1 | - | - | - | 0ms | 683 chars, ~171 tokens; est prefill ~0.17s @ 1000t/s (estimate, not live) |
| B4.continuationPrompt.10t | continuationPrompt (10-task tree) | prompts/goal-prompts | 10 tasks (half complete, contracts+evidence) | 19 | 1 | - | - | - | 0ms | 73 chars, ~19 tokens; est prefill ~0.02s @ 1000t/s (estimate, not live) |
| B4.goalPrompt.10t | goalPrompt (10-task tree) | prompts/goal-prompts | 10 tasks (half complete, contracts+evidence) | 651 | 1 | - | - | - | 0ms | 2602 chars, ~651 tokens; est prefill ~0.65s @ 1000t/s (estimate, not live) |
| B4.taskListBlock.50t | taskListBlock (50-task tree) | prompts/goal-prompts | 50 tasks (half complete, contracts+evidence) | 119 | 1 | - | - | - | 0ms | 473 chars, ~119 tokens; est prefill ~0.12s @ 1000t/s (estimate, not live) |
| B4.continuationPrompt.50t | continuationPrompt (50-task tree) | prompts/goal-prompts | 50 tasks (half complete, contracts+evidence) | 19 | 1 | - | - | - | 0ms | 73 chars, ~19 tokens; est prefill ~0.02s @ 1000t/s (estimate, not live) |
| B4.goalPrompt.50t | goalPrompt (50-task tree) | prompts/goal-prompts | 50 tasks (half complete, contracts+evidence) | 598 | 1 | - | - | - | 0ms | 2392 chars, ~598 tokens; est prefill ~0.6s @ 1000t/s (estimate, not live) |
| B5.startup.1g | session startup loadState (1 goal, parallel reads) | goal-state + storage/goal-files + goal-settings | 1 open goals | 0 | 6 | 0.1 | 2.9 | 2.9 | 0ms | mean 0.5ms; P1-7 parallel + cached |
| B5.startup.1g.lat25 | session startup loadState (1 goal, +25ms/op) | goal-state + storage/goal-files + goal-settings | 1 open goals | 0 | 3 | 0 | 0 | 0 | 25ms/op | P1-7 parallel reads amortise the per-op latency |
| B5.startup.10g | session startup loadState (10 goals, parallel reads) | goal-state + storage/goal-files + goal-settings | 10 open goals | 0 | 6 | 0 | 4.8 | 4.8 | 0ms | mean 0.8ms; P1-7 parallel + cached |
| B5.startup.10g.lat25 | session startup loadState (10 goals, +25ms/op) | goal-state + storage/goal-files + goal-settings | 10 open goals | 0 | 3 | 0 | 0 | 0 | 25ms/op | P1-7 parallel reads amortise the per-op latency |
| B5.startup.50g | session startup loadState (50 goals, parallel reads) | goal-state + storage/goal-files + goal-settings | 50 open goals | 0 | 6 | 0.1 | 19.7 | 19.7 | 0ms | mean 3.3ms; P1-7 parallel + cached |
| B5.startup.50g.lat25 | session startup loadState (50 goals, +25ms/op) | goal-state + storage/goal-files + goal-settings | 50 open goals | 0 | 3 | 0 | 0 | 0 | 25ms/op | P1-7 parallel reads amortise the per-op latency |
| B5.lock.contended | lock acquire under two-process contention (child holds 3s, DEFAULT bounds) | storage/goal-lock | 2 processes, 1 goal lock | - | 1 | 10.7 | 10.7 | 10.7 | 0ms | fail-fast in 10.7ms; P1-5 bounded window ≈200ms (was ~2.8s frozen) |
| B5.auditor.dispatch | update_goal(complete) dispatch to pre-audit gate (auditor stubbed) | goal-core-tools + goal-completion + goal-state + goal-service + goal-ledger | 1 active goal each, 5 fixtures | - | 5 | 1.5 | 4.9 | 4.9 | 0ms | cold=1.3ms warm=4.9ms; P1-6 seeds the auditor session warm |
| B7.tool.create_goal | create_goal handler | goal-core-tools + goal-state + goal-service + goal-notifications | 1 focused fixture | 44 | 5 | 2.5 | 5.5 | 5.5 | 0ms | fs ops/case ~44; mean 3ms |
| B7.tool.get_goal | get_goal handler | goal-core-tools + goal-state + goal-format + goal-pool | 1 focused fixture | 0 | 5 | 0.1 | 0.7 | 0.7 | 0ms | fs ops/case ~0; mean 0.3ms |
| B7.tool.update_goal.paused | update_goal(paused) handler | goal-core-tools + goal-state + goal-service | 1 focused fixture | 22 | 5 | 1 | 1.8 | 1.8 | 0ms | fs ops/case ~22; mean 1.2ms |
| B7.tool.update_goal.blocked | update_goal(blocked) handler | goal-core-tools + goal-service + goal-ledger | 1 focused fixture | 22 | 5 | 0.9 | 1.6 | 1.6 | 0ms | fs ops/case ~22; mean 1.1ms |
| B7.tool.set_goal_tasks.50 | set_goal_tasks (50 tasks) handler | goal-task-tools + goal-task-confirmation + goal-policy + goal-service | 1 focused fixture | 22 | 5 | 1 | 1.5 | 1.5 | 0ms | fs ops/case ~22; mean 1.1ms |
| B7.tool.update_goal_task | update_goal_task(complete) handler | goal-task-tools + goal-service + storage/goal-lock + goal-ledger | 1 goal, 20 tasks | 24 | 5 | 1.3 | 1.8 | 1.8 | 0ms | fs ops/case ~24; mean 1.4ms |
| B7.evt.before_agent_start | before_agent_start event (1 goal, 1k ledger) | goal-events + goal-state + goal-service + goal-ledger + prompts/goal-prompts | 1 goal, 1000 events | - | 5 | 0 | 0.1 | 0.1 | 0ms | mean 0ms; P1-1/2 cut the reads here |
| B7.render.confirmationTasks | renderConfirmationTasks (20 tasks) | goal-task-confirmation | 20-task tree | - | 50 | 0 | 0 | 0 | 0ms | mean 0ms |
| B7.render.draftConfirmation | buildDraftConfirmationText | goal-draft | 1 goal, 20 tasks | - | 50 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B7.render.questionnaireAnswers | formatQuestionnaireAnswers (3 Q&A) | goal-questionnaire | 3 answers | - | 200 | 0 | 0 | 0 | 0ms | mean 0ms |
| B7.render.widgetLines | renderGoalWidgetLines (20 tasks) | widgets/goal-widget | 1 goal, 20 tasks | - | 100 | 0.1 | 0.3 | 0.9 | 0ms | mean 0.1ms |
| B7.render.widgetComponent | GoalWidgetComponent.render (mock TUI) | widgets/goal-widget | 1 goal, 20 tasks | - | 100 | 0.1 | 0.3 | 0.4 | 0ms | mean 0.1ms |
| B7.render.escapeDialog | escape dialog render | widgets/goal-escape-dialog | objective text | - | 100 | 0 | 0.1 | 0.2 | 0ms | mean 0ms |
| B7.policy.taskSummary | buildTaskSummary (20 tasks) | goal-policy | 20-task tree | - | 200 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B7.policy.completionReport | buildCompletionReport | goal-policy | 1 goal, 20 tasks | - | 200 | 0 | 0 | 0 | 0ms | mean 0ms |
| B7.pool.goalList | buildGoalListText (10 goals) | goal-pool + goal-core + goal-format | 10 open goals | - | 200 | 0 | 0 | 1.4 | 0ms | mean 0ms |
| B7.pool.selectorLabel | goalSelectorLabel | goal-pool + goal-core | 1 goal | - | 2000 | 0 | 0 | 0.2 | 0ms | mean 0ms |
| B7.accounting.charge | GoalAccounting begin+charge+end | goal-accounting | 1 active goal | - | 200 | 0 | 0 | 0 | 0ms | mean 0ms |
| B7.accounting.budget | budgetLine + budgetRemaining | goal-accounting | goal with 100k budget | - | 2000 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B7.notifications.running | buildGoalRunningNotification | widgets/goal-notifications | 1 config | - | 2000 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B7.ledger.reconstruct | reconstructGoalLedger (500 events) | goal-ledger | 500 events | - | 50 | 0.1 | 0.2 | 0.3 | 0ms | mean 0.1ms |
| B7.ledger.latestEvents | latestEventsForGoal (500 events) | goal-ledger | 500 events | - | 500 | 0 | 0 | 0.2 | 0ms | mean 0ms |
| B7.contract.extract | extractVerificationContract | goal-contract + goal-draft | objective text | - | 2000 | 0 | 0 | 0.2 | 0ms | mean 0ms; P1-11 dedups the goal-draft copy |
| B7.contract.promptSafe | promptSafeObjective | goal-contract | objective text | - | 2000 | 0 | 0 | 0.5 | 0ms | mean 0ms |
| B7.record.normalize | normalizeGoalRecord | goal-record | raw record | - | 2000 | 0 | 0 | 0 | 0ms | mean 0ms |
| B7.files.serialize | serializeGoalFile | storage/goal-files + goal-core + goal-record | 1 goal | - | 1000 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B7.files.parse | parseGoalFile | storage/goal-files + goal-record | 1 goal file | - | 200 | 0 | 0 | 0 | 0ms | mean 0ms; P1-1 caches per-turn parse |
| B7.format.renderEvent | renderGoalEvent heading | goal-format | task_complete event | - | 2000 | 0 | 0 | 0.2 | 0ms | mean 0ms |
| B7.format.goalDetails | goalDetails | goal-format + goal-accounting | 1 goal, 20 tasks | - | 2000 | 0 | 0 | 0.6 | 0ms | mean 0ms |
| B7.runtime.stalePrompt | staleContinuationPrompt | prompts/goal-prompts + goal-core | 1 goal | - | 2000 | 0 | 0 | 0.2 | 0ms | mean 0ms |
| B7.runtime.unfocusedPrompt | unfocusedOpenGoalsPrompt | prompts/goal-prompts | 3 open goals | - | 2000 | 0 | 0 | 0 | 0ms | mean 0ms |
| B7.dashboard.model.20t | deriveGoalDashboardModel (20 tasks, 12 events) | widgets/goal-dashboard-model + goal-activity + goal-core | 1 goal, 20 tasks, 12 events | - | 100 | 0 | 0 | 0 | 0ms | mean 0ms |
| B7.dashboard.model.50t | deriveGoalDashboardModel (50 tasks, 12 events) | widgets/goal-dashboard-model + goal-activity + goal-core | 1 goal, 50 tasks, 12 events | - | 100 | 0 | 0 | 0.2 | 0ms | mean 0ms |
| B7.dashboard.compact.20t | renderCompactDashboard (20 tasks) | widgets/goal-dashboard-renderer | 1 goal, 20 tasks | - | 100 | 0 | 0.2 | 0.5 | 0ms | mean 0.1ms |
| B7.dashboard.expanded.20t | renderExpandedDashboard (20 tasks, 24 rows) | widgets/goal-dashboard-renderer | 1 goal, 20 tasks | - | 100 | 0.1 | 0.2 | 1 | 0ms | mean 0.1ms |
| B7.dashboard.expanded.50t | renderExpandedDashboard (50 tasks, 24 rows) | widgets/goal-dashboard-renderer | 1 goal, 50 tasks | - | 100 | 0.1 | 0.1 | 0.3 | 0ms | mean 0.1ms |
| B7.dashboard.currentTask | renderCurrentTaskBlock (current task) | widgets/goal-dashboard-renderer | 1 goal, current task | - | 100 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B7.dashboard.activity | renderActivityBlock (8 items) | widgets/goal-dashboard-renderer | 8 activity items | - | 200 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B7.dashboard.unfocused | renderUnfocusedDashboard (3 open goals) | widgets/goal-dashboard-renderer | 3 open goals | - | 200 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B7.dashboard.auditor | deriveAuditorDashboardModel + renderAuditorDashboard (running) | widgets/auditor-dashboard-model + widgets/goal-dashboard-renderer | running audit | - | 100 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B7.dashboard.auditCard | deriveAuditResultCard + renderAuditResultCard | widgets/auditor-dashboard-model + widgets/goal-dashboard-renderer | disapproved verdict | - | 200 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B7.dashboard.anchoredScroll.50t | flatten + anchoredScrollOffset (50 tasks) | widgets/goal-dashboard-model | 50-task tree | - | 500 | 0 | 0 | 0.2 | 0ms | mean 0ms |
| B7.dashboard.viewport | deriveTaskListViewport (50 rows, 24 visible, offset 7) | widgets/goal-dashboard-model | viewport math | - | 2000 | 0 | 0 | 0 | 0ms | mean 0ms |
| B7.dashboard.statusText | buildGoalStatusText standard (20 tasks) | goal-status + widgets/goal-dashboard-* | 1 goal, 20 tasks, 12 events | - | 100 | 0.1 | 0.2 | 1.4 | 0ms | mean 0.1ms |
| B7.dashboard.deriveTasks | deriveTasksFromObjective (5 markers) | goal-task-derive | objective with 5 checklist markers | - | 500 | 0 | 0 | 0.1 | 0ms | mean 0ms |
| B10.checkpoint.persisted.1 | persisted checkpoint chars (1 turns) | prompts/goal-prompts | 1 unchanged continuation turns | 68 | 1 | - | - | - | 0ms | v2 marker is 68 chars; objective occurrences in persisted checkpoints must be 0 |
| B10.checkpoint.persisted.10 | persisted checkpoint chars (10 turns) | prompts/goal-prompts | 10 unchanged continuation turns | 680 | 1 | - | - | - | 0ms | v2 marker is 68 chars; objective occurrences in persisted checkpoints must be 0 |
| B10.checkpoint.persisted.100 | persisted checkpoint chars (100 turns) | prompts/goal-prompts | 100 unchanged continuation turns | 6800 | 1 | - | - | - | 0ms | v2 marker is 68 chars; objective occurrences in persisted checkpoints must be 0 |
| B10.checkpoint.persisted.1000 | persisted checkpoint chars (1000 turns) | prompts/goal-prompts | 1000 unchanged continuation turns | 68000 | 1 | - | - | - | 0ms | v2 marker is 68 chars; objective occurrences in persisted checkpoints must be 0 |
| B10.checkpoint.provider-context.1000 | unbounded provider-visible checkpoints (1000-turn fixture) | extensions/goal-events | 1001 checkpoints (1000 legacy + 1 v2), 50-task tree | 0 | 1 | - | - | - | 0ms | must be 0; all 1001 bounded triggers retain their history positions |
| B10.checkpoint.recovery.850 | checkpoint chars after offline recovery (850-entry legacy fixture) | scripts/recover-session-checkpoints.mjs | 850 legacy checkpoints (~6400 chars each) | 51850 | 1 | - | - | - | 0ms | was ~5440000 chars; saved 7140000; must be <= 5% of legacy |
| B10.checkpoint.composed-request.50t | full goal blocks in composed request (50-task tree) | prompts/goal-prompts + extensions/goal-events | system prompt with injected goal block + latest checkpoint marker | 1 | 1 | - | - | - | 0ms | objective occurs 1x; both counts must be exactly 1 |
| B11.session.turn.early | goal turn, first 20 turns | all hooks | 3 requests per turn | 44 | 20 | 4.73 | 4.73 | 9.65 | 0ms | fs ops/turn 44 |
| B11.session.turn.late | goal turn, last 20 of 240 turns | all hooks | 1920 messages, 2844 KiB history | 44 | 20 | 32.37 | 32.37 | 42.91 | 0ms | fs ops/turn 44; growth x6.84 |
| B11.session.hook.slowest | slowest hook in the last turn (context_with_system) | goal-events | 1920 messages | - | 1 | 27.14 | 27.14 | 27.14 | 0ms | before_agent_start 0.18; agent_start 0.01; turn_start 0.02; context_with_system 27.14; tool_call 0.03; tool_execution_end 0.07; turn_end 1.96; agent_end 1.57 |
