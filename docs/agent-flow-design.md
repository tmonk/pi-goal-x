# pi-goal Agent 流程设计

这份文档用于理解当前 `pi-goal` 项目的 agent 流程设计：用户如何提出目标，执行 agent 如何工作，独立 auditor 如何审计，runtime 如何维护状态、ledger、UI 与自动续跑。

## 1. 核心心智模型

`pi-goal` 不是另一个通用 agent，而是一个 pi extension。它给主 coding agent 加上一层“长期目标运行时”：目标需要被用户明确确认，执行过程有生命周期，完成时必须经过独立审计。

当前系统里有四个角色：

| 角色 | 职责 |
|---|---|
| 用户 | 拥有意图。启动目标、确认草案、选择 focus、恢复/清理/中止目标。 |
| 执行 agent | 在已确认的 focused goal 上工作。可以暂停、终止、请求完成。 |
| 审计 agent | 一个独立的 in-memory pi agent session，负责检查完成声明是否真的满足目标。 |
| `pi-goal` runtime | 维护目标状态、工具可见性、prompt、ledger、UI widget 与自动续跑。 |

核心原则是：

> 用户拥有意图；执行 agent 完成工作；审计 agent 独立验证；runtime 负责协调与记录。

## 2. 总体流程

```text
用户命令
  -> pi-goal command handler
  -> 进入轻量 confirmation 或更新 focus/lifecycle 状态
  -> runtime 重新计算 prompt 与 tool surface
  -> 执行 agent 按 focused goal 工作
  -> tool call / turn event 更新 accounting 与 ledger
  -> 执行 agent 调用 complete_goal 请求完成
  -> 独立 auditor agent 检查完成声明
  -> 只有 auditor approval 才归档为 complete
```

一次成功运行大致是：

```text
/goals 或 /sisyphus
  -> 发送轻量 intent/confirmation 指令
  -> agent 询问必要澄清问题，或在请求足够明确时直接 proposal
  -> agent 调用 propose_goal_draft
  -> 用户确认
  -> 写入 active goal 文件并设置 focus
  -> agent 跨一个或多个 turn 执行工作
  -> agent 调用 complete_goal(status="complete")
  -> 对话中出现 Goal audit started
  -> auditor session 检查真实产物
  -> 对话中出现 Goal audit approved
  -> Goal complete，并归档目标
```

## 3. 主要状态容器

`extensions/goal.ts` 里维护一个项目级 open goal pool 和一个 session-local focus：

```ts
let goalsById = new Map<string, GoalRecord>();
let focusedGoalId: string | null = null;
```

含义：

- `goalsById` 从 `.pi/goals/active_goal_*.md` 文件恢复。
- `focusedGoalId` 从当前 session branch 的 `pi-goal-focus` entry 恢复。
- focus 不写入 goal markdown，因此不同 pi session branch 可以 focus 不同目标。
- `state.goal` 是 focused goal 的便捷 getter/setter。

还有一些运行时瞬态状态：

| 状态 | 作用 |
|---|---|
| `confirmationIntent` | 当前 `/goals` 或 `/sisyphus` 的轻量确认意图，只保存 focus、原始 topic 和开始时间。 |
| `tweakDraftingFor` | 当前 `/goal-tweak` 流程对应的 goal id。 |
| `continuationQueuedFor` / `continuationScheduledFor` | 避免同一 goal 重复排队 auto-continue。 |
| `runningGoalId` | 防止 focus 改变后旧 tool call 继续作用在错误 goal 上。 |
| `goalWorkToolCalledThisTurn` | empty-turn guard：只有本 turn 做了有意义工作才继续 auto-continue。 |
| `turnStoppedFor` | pause/abort/complete/tweak 后阻止同一 turn 继续乱调用工具。 |
| `postCompactReminderPending` | session compact 后给下一轮 agent 注入 deterministic resync prompt。 |
| `focusRevision` | session focus 改变时递增；异步 completion/tweak/task proposal 在写入前必须验证 revision，避免 unfocus 后迟到结果修改共享 goal。 |
| `hasExplicitSessionFocus` | 区分“从未选择 focus”和显式 null focus，保证 resume/tree 不覆盖 `/goal-unfocus`。 |
| `activeGetGoalTurnsByGoalId` | 统计重复 `get_goal`，用于 soft nudge，不是 hard block。 |

## 4. 持久化：Goal 文件与 Ledger

### 4.1 Goal 文件

open 和 archived goals 存在 `.pi/goals/` 下：

```text
.pi/goals/active_goal_<timestamp>_<id>.md
.pi/goals/archived/goal_<timestamp>_<id>.md
```

每个 goal 文件包含：

1. extension 管理的 metadata；
2. 用户可编辑的 `# Goal Prompt`；
3. 状态和使用量等信息。

在执行重要操作前，runtime 会重新读取 focused active goal 文件并合并磁盘状态。这样外部编辑、归档、删除、暂停等操作会优先于旧内存状态。

### 4.2 Ledger 文件

runtime 还会把生命周期事件追加到：

```text
.pi/goals/goal_events.jsonl
```

常见事件包括：

- `goal_created`
- `goal_focused` / `goal_unfocused`
- `goal_paused`
- `goal_resumed`
- `completion_requested`
- `audit_started`
- `audit_result`
- `goal_completed`
- `goal_aborted`
- `goal_tweaked`

ledger 的作用：

- 提供 durable history；
- 支持 compaction 后恢复目标上下文；
- 保存 auditor rejection，让后续 prompt 能提醒 agent 先解决审计意见；
- 支持重建 terminal goals 和近期事件。

ledger append 是 best-effort：写入失败不应该让用户的生命周期动作崩溃。

## 5. 命令体系：用户拥有意图

高层意图只能由用户命令启动或改变。

| 命令 | 作用 |
|---|---|
| `/goals <topic>` | 开始 regular goal intent discussion，可澄清、研究、拷问后 proposal。 |
| `/sisyphus <topic>` | 开始 Sisyphus 风格 intent discussion，重点拷问 ordered steps、done criteria 和 blockers。 |
| `/goals-set <objective>` | 直接创建并启动 regular goal，不进入 draft discussion。 |
| `/sisyphus-set <objective>` | 直接创建并启动 Sisyphus goal，不进入 draft discussion。 |
| `/goal-list` | 列出 `.pi/goals/` 下所有 open goals。 |
| `/goal-focus` | 让用户选择当前 session focus。 |
| `/goal-unfocus` | 清除当前 session focus，终止该 session 的 continuation/in-flight work/audit，并用 revision gate 丢弃迟到异步结果；不暂停、修改、归档共享 goal，也不写 project-global focus event。 |
| `/goal-status` / `/goal` | 显示 focused goal 状态和其他 open goals 提示。 |
| `/goal-tweak <change>` | 修改 focused goal，但也要先走 tweak drafting。 |
| `/goal-pause` | 用户暂停 focused active goal。 |
| `/goal-resume` | 在策略允许时恢复 paused goal。 |
| `/goal-clear` | 归档 focused goal，或取消 goal confirmation。 |
| `/goal-abort` | 中止/归档 focused goal，或取消 goal confirmation。 |
| `/goal-settings` | 配置 auditor provider/model/thinking。 |

agent 不能任意切换 focus。如果有多个 open goals 且当前 session 没有 focus，需要目标的命令会让用户选择一个 goal。

## 6. Goal Confirmation 流程

confirmation 是收集用户意图的轻量对话阶段，不是正式执行阶段，也不是长期运行状态机。

当前设计：

- `propose_goal_draft` 常驻可见，但只有 `/goals` 或 `/sisyphus` 产生的 confirmation intent 存在时会通过 validator；
- agent 可以用 `goal_question` 或 `goal_questionnaire` 询问具体问题，也可以用普通对话澄清；
- 如果用户请求已经非常完整，可以直接 proposal；
- 如果能直接改善 goal contract，允许 targeted read-only research/reconnaissance；
- 直接 `create_goal` 仍然隐藏并拒绝，discussion-based 创建必须经过 `propose_goal_draft` 和用户确认；
- `/goals-set` 与 `/sisyphus-set` 是用户显式 direct set 快捷路径，会直接创建目标并开始执行。

`confirmationIntent` 形态：

```ts
interface GoalConfirmationIntent {
  focus: "goal" | "sisyphus";
  originalTopic: string;
  startedAt: number;
}
```

典型流程：

```text
/goals topic
  -> 创建 confirmationIntent
  -> 发送普通 confirmation 指令
  -> agent 澄清问题或在目标足够清楚时直接 proposal
  -> propose_goal_draft 校验 focus / objective
  -> 用户看到确认对话框
  -> Confirm：创建并 focus goal
  -> Continue Chatting：继续 clarification，不创建 goal
```

确认后，系统会把完整最终目标打印到 transcript，并写入 `.pi/goals/active_goal_*.md`。使用 `/goals-set` 或 `/sisyphus-set` 时没有确认对话，命令参数会直接写入 active goal 文件并成为当前 session focus。

## 7. Tool Surface 与 Runtime Gates

`syncGoalTools()` 会在状态变化时重新计算当前可用工具。

重要工具：

| 工具 | 作用 |
|---|---|
| `get_goal` | 读取 focused goal 状态。重复调用只触发 soft nudge，不 hard block。 |
| `goal_question` / `goal_questionnaire` | goal confirmation / tweak drafting 中的结构化用户对话。 |
| `propose_goal_draft` | 提交 goal 草案给用户确认；没有 confirmation intent 时会被 validator 拒绝。 |
| `apply_goal_tweak` | 提交并应用 goal 修改。 |
| `complete_goal` | 请求完成目标，并触发独立审计。 |
| `pause_goal` | agent 因真实 blocker 暂停目标。 |
| `abort_goal` | agent 因目标废弃、不可行、不安全等原因中止目标。 |
| `step_complete` | 隐藏的 legacy no-op；Sisyphus 不再使用 step counter。 |
| `create_goal` | 隐藏且拒绝；普通创建必须走 proposal/confirmation。 |

当前仍保留的 hard gates 是小而机械的：

- 直接 `create_goal` 拒绝；
- mismatched confirmation mode proposal 拒绝；
- 非法 lifecycle transition 拒绝；
- stop tool 成功后，同一 turn 里阻止继续调用非允许工具；
- stale continuation message 会被 neutralize；
- completion 必须 auditor `<approved/>`。

已经移除或软化的硬限制：

- auto-continue 不按固定轮数停止；
- 重复 `get_goal` 不再 hard block，只 soft nudge；
- `propose_goal_draft` 前不再强制 runtime question gate；
- confirmation 阶段不依赖 hard whitelist、question counter 或 hidden prompt identity，更多由 prompt 指导。 

## 8. 执行循环与 Auto-Continue

goal active 且 `autoContinue` 为 true 时，runtime 会在适当时机排队 continuation prompt。

事件驱动流程：

```text
turn_start
  -> 重置 per-turn flags
  -> begin usage accounting

tool_call
  -> 执行 post-stop block
  -> 统计重复 get_goal 用于 soft nudge
  -> 标记 meaningful work tool

tool_execution_end
  -> 统计 elapsed time

turn_end
  -> 统计 assistant tokens
  -> 如果 assistant 被 abort，则 pause goal
  -> 从磁盘刷新 goal
  -> 如果本 turn 有 meaningful work 且 goal 仍 active，则 queueContinuation
```

empty-turn guard 仍然存在：如果一个 turn 只是聊天，没有做任何有意义的 goal-work tool，就不会继续 auto-continue。它只防止纯聊天循环烧 token，不按固定轮数停止。

`get_goal`、question tools、draft proposal tools 不算实际执行进度。

## 9. Completion 与可见 Audit 阶段

completion 不信任执行 agent 单方声明，而是一个双 agent 协议。

### 9.1 执行 agent 请求完成

执行 agent 调用：

```json
{
  "status": "complete",
  "completionSummary": "说明完成了什么，以及有哪些证据"
}
```

`complete_goal` 会先校验 focused goal 是否可以完成，然后写入 `completion_requested` ledger event。

### 9.2 对话中出现 audit started

运行 auditor 前，runtime 会插入一条独立可见消息，custom type 是 `pi-goal-audit-event`：

```text
Goal audit started
Auditor: I am starting the independent completion audit.
Goal id: ...
Auditor model: ...
Completion claim: ...
```

这让 audit 成为 transcript 里一个明确的 agentic 阶段，而不是隐藏在 `complete_goal` tool result 里。

### 9.3 独立 auditor session

`runGoalCompletionAuditor()` 会创建一个独立 in-memory pi session：

- 使用同一个 cwd；
- 默认使用当前 pi model，除非 auditor settings 覆盖；
- 不加载 extension resources 和 skills；
- 工具限制为 `read`、`grep`、`find`、`ls`、`bash`；
- auditor prompt 要求语义审计；
- 最后一行必须是 `<approved/>` 或 `<disapproved/>`。

Auditor 收到的信息：

- 完整 goal objective；
- executor completion claim；
- 当前 goal metadata 和 detailed summary。

### 9.4 对话中出现 audit result

如果通过，runtime 插入：

```text
Goal audit approved
Auditor: I approve this completion claim.
Auditor model: ...

Audit Report
...
<approved/>
```

如果拒绝，runtime 插入：

```text
Goal audit rejected

Goal completion rejected by independent auditor.
Auditor model: ...
Auditor error: ...

Audit Report 或 rejection reason
```

### 9.5 归档 complete

只有 audit approved 后，runtime 才会：

1. 统计剩余 usage；
2. 将 goal stop 为 `complete`；
3. 归档 goal 文件；
4. 清空 session focus；
5. 写入 `goal_completed` ledger event；
6. 返回最终 `Goal complete.` tool result。

最终 completion result 不再需要重复完整 auditor report，因为 auditor 已经作为单独对话阶段出现。

## 10. Pause、Abort 与 Post-Stop 行为

agent 可以在真实 blocker 下调用 `pause_goal`。用户也可以用 `/goal-pause` 或 abort active run 来暂停目标。

`pause_goal`、`abort_goal`、`complete_goal`、`apply_goal_tweak` 成功后，会设置 `turnStoppedFor`。之后同一个 turn 里，`tool_call` hook 会阻止额外的非允许工具调用。这个 hard gate 仍然保留：生命周期已经 stop 后，agent 应该总结并交还控制，而不是继续修改文件。

pause 与 abort 的区别：

- pause 表示目标之后可能恢复；
- abort 表示目标废弃、不可行、不安全或用户取消，应归档。

两者都会写入 ledger。

## 11. Compaction 与 Auditor Rejection 记忆

session compaction 发生时，`session_compact` 可能设置 `postCompactReminderPending`。下一次 `before_agent_start` 会注入 deterministic compaction summary。

summary 来自：

- focused goal；
- other open goals；
- recent ledger events；
- terminal goals；
- latest auditor rejection。

如果 focused goal 最近一次 audit 是 `disapproved`，active / paused prompt 会显式提醒 auditor rejection，避免 agent 不处理问题就反复请求完成。

## 12. 当前流程图

```text
User
  |
  | /goals 或 /sisyphus
  v
Confirmation runtime
  |-- 发送轻量 intent/confirmation 指令
  |-- 暴露 dialogue/proposal tools
  v
Executor agent
  |-- 询问用户或提交草案
  v
User confirmation
  |-- Continue Chatting -> 继续 clarification
  |-- Confirm -> 创建并 focus goal
  v
Execution runtime
  |-- active prompt + work tools
  |-- meaningful work 后 auto-continue
  |-- accounting/ledger
  v
Executor agent
  |-- 正常 read/write/bash/edit 工作
  |-- pause_goal / abort_goal / complete_goal
  v
Completion request
  |-- 对话中出现 Goal audit started
  v
Auditor agent session
  |-- read-only-oriented inspection
  |-- 输出 <approved/> 或 <disapproved/>
  v
Visible audit result
  |-- rejected -> goal 保持 open
  |-- approved -> 归档 goal
  v
Final completion report
```

## 13. 代码入口索引

| 主题 | 文件 |
|---|---|
| extension orchestration、commands、tools、hooks | `extensions/goal.ts` |
| goal record 类型和 normalization | `extensions/goal-record.ts` |
| lifecycle policy 与最终 report | `extensions/goal-policy.ts` |
| lightweight confirmation prompt 与 proposal validation | `extensions/goal-draft.ts` |
| 独立 auditor session | `extensions/goal-auditor.ts` |
| durable ledger | `extensions/goal-ledger.ts` |
| post-compaction summary | `extensions/goal-compaction.ts` |
| goal files 与 archive IO | `extensions/storage/goal-files.ts` |
| active / continuation prompts | `extensions/prompts/goal-prompts.ts` |
| UI widget | `extensions/widgets/goal-widget.ts` |

## 14. 重要设计取舍

- runtime 仍是 TypeScript hook-driven 架构，不是集中式 OTP orchestrator。
- ledger 是 best-effort event log，不是事务数据库。
- audit 的模型/session 是独立的，但可见 transcript 消息由 `pi-goal` 在 auditor 返回后桥接出来。
- 多个 hard limits 已经改成 soft guidance，但 completion 和 post-stop safety 仍是 hard gate。
- auto-continue 不按固定轮数停止；剩余刹车是用户 pause/abort、completion、post-stop gate 和 empty-turn guard。
- 多个 open goals 是 durable project state；focus 是 human-owned session state。
