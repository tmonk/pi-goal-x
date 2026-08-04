# PRD: Agentic Goal Runtime

> **Historical proposal (partly implemented, superseded 2026-08-03).** Tool
> names, drafting flow, and non-goals below describe the design at the time and
> are not the current API. Current behavior is documented in
> [`docs/architecture.md`](architecture.md); the governing implemented plans
> are the
> [2026-08-04 hardening spec](../specs/2026-08-04-goal-simplification-hardening/PRODUCT.md)
> and the
> [2026-08-04 runtime follow-up](../specs/2026-08-04-goal-runtime-follow-up/PRODUCT.md).

## 1. Summary

`pi-goal` currently behaves like a growing workflow state machine: drafting gates, focus gates, continuation gates, tool visibility gates, lifecycle gates, completion auditing, compaction recovery, and multi-goal focus rules all interact inside the extension runtime. This has improved safety, but it also increases hidden coupling and makes the system brittle as more multi-agent behavior is added.

This PRD proposes a shift toward an agentic runtime modeled after `pi-autoresearch`: keep durable facts in append-only artifacts, use deterministic reconstruction for long-running context, and move most strategy into prompts, skills, and independent reviewer agents. The extension should enforce only the small set of invariants that protect irreversible state transitions, user ownership, path safety, and audit integrity.

The new system should feel less like a rigid state machine and more like an agent-operated workspace with reliable transaction logs and semantic review.

## 2. Problem Statement

The current implementation has accumulated many hard runtime constraints that try to prevent the assistant from making mistakes at every stage. Examples include:

- Drafting requires a question-like tool before `propose_goal_draft`.
- Drafting blocks workhorse tools such as `read`, `bash`, `grep`, `find`, `write`, and `edit`.
- Active goals block drafting/question tools.
- Repeated `get_goal` calls can be blocked.
- Tool availability is repeatedly synchronized based on fine-grained lifecycle phase.
- Prompt text often references runtime gates, and tests assert exact rejection strings.

These constraints were added in response to real failures, but they create several product and engineering problems:

1. **Complexity leaks into every feature.** A new lifecycle feature must reason about drafting, focus, continuation, compaction, post-stop behavior, and tool gating.
2. **Agent behavior becomes over-constrained.** The model cannot use reasonable judgment in edge cases, such as doing minimal reconnaissance before drafting a better goal.
3. **Tests encode machinery, not outcomes.** Experiments increasingly verify that the runtime blocked specific tool calls rather than verifying that the final goal behavior was correct.
4. **State source of truth is fragmented.** Current state is reconstructed from active markdown files, focus entries, session entries, and runtime memory.
5. **Multi-agent cooperation is bolted on.** The independent auditor is a good direction, but its results should become durable context rather than a one-off tool response.
6. **Compaction resilience remains prompt-heavy.** Long-running goal context should be deterministic and artifact-backed, not dependent on chat history or LLM summarization.

## 3. Product Goals

### 3.1 Primary Goals

- Convert `pi-goal` from a hard state-machine-first system into an agentic lifecycle system.
- Introduce an append-only goal ledger as the durable factual record of lifecycle events.
- Use deterministic goal summaries for compaction and session recovery.
- Move strategy and behavioral guidance from runtime gates into prompts, skills, and reviewer agents.
- Preserve safety for irreversible transitions: goal creation, focus ownership, completion, archive/delete, stale continuations, and file path safety.
- Make independent auditor feedback durable and actionable across future turns.
- Reduce hidden coupling in `extensions/goal.ts` and make future behavior easier to evolve.

### 3.2 Secondary Goals

- Make experiments evaluate outcomes instead of exact gate mechanics.
- Support future goal-specialized skills such as `goal-draft`, `goal-execute`, `goal-sisyphus`, and `goal-finalize`.
- Allow minimal agent reconnaissance during drafting when it improves the goal contract, without starting substantive execution before user confirmation.
- Improve debuggability: every important lifecycle transition should be inspectable in a log.
- Preserve backward compatibility with existing `.pi/goals/active_goal_*.md` files.

## 4. Non-Goals

- Do not remove user confirmation before goal creation.
- Do not allow hidden/direct `create_goal` as a normal creation path.
- Do not remove the independent completion auditor.
- Do not let agents mark goals complete without auditor approval.
- Do not let agents autonomously switch human-owned focus.
- Do not reintroduce hard token-cost control or auto-continue-cap gates without explicit product approval.
- Do not redesign the entire pi extension framework.
- Do not require users to migrate existing goal files manually.
- Do not implement a separate Sisyphus step counter; Sisyphus remains prompt/criteria style.

## 5. Users and Use Cases

### 5.1 Primary User

A developer using pi for long-running coding, research, writing, release, or maintenance work. They want the assistant to keep track of goals durably without becoming brittle or bureaucratic.

### 5.2 Secondary Users

- Extension maintainer reviewing behavior and debugging failures.
- Future skills or subagents that need stable goal context.
- Independent auditor agents evaluating completion quality.
- Experiment harnesses validating goal behavior.

### 5.3 Core Use Cases

1. **Start a goal from a clear request.** The agent drafts a concrete goal, shows a confirmation dialog, and starts work after user confirmation.
2. **Start a goal from a vague request.** The agent asks clarifying questions, proposes a goal when clear enough, and avoids premature execution.
3. **Continue a long-running goal.** The agent reads deterministic goal context and chooses the next concrete action.
4. **Recover after compaction.** The agent resumes from ledger and deterministic summary, not from fragile chat memory.
5. **Handle multiple open goals.** The user owns focus selection; the agent does not silently switch targets.
6. **Pause or abort safely.** The lifecycle transition is logged and future prompts show why it happened.
7. **Attempt completion.** The agent requests completion; an independent auditor approves or rejects; the result is durable context.
8. **React to auditor rejection.** Future turns include the auditor objections and guide the agent to address them before retrying.

## 6. Current State Overview

The current runtime uses several state sources and gates:

- Active goal markdown files in `.pi/goals/active_goal_*.md`.
- Archived files in `.pi/goals/archived/`.
- Session focus entries via `pi-goal-focus`.
- In-memory `goalsById`, `focusedGoalId`, `confirmationIntent`, `tweakDraftingFor`, `runningGoalId`, continuation queues, and accounting state.
- Tool visibility synchronization through `syncGoalTools()`.
- Runtime tool-call blocking for lifecycle transactions, post-stop same-turn behavior, stale continuation prompts, and strict completion auditing; goal confirmation is mostly prompt-guided.
- Independent completion auditor in `extensions/goal-auditor.ts`.
- Prompt guidance in `extensions/prompts/goal-prompts.ts`.

The system is safe but increasingly hard to reason about because many behaviors are encoded twice: once in prompt text and again as hard runtime gates.

## 7. Desired Product Behavior

### 7.1 Agentic Contract

The agent should be treated as the primary planner and executor. The extension should provide durable facts, transaction tools, prompts, and independent review, but should not micromanage ordinary reasoning steps.

The runtime should answer:

- What goals exist?
- Which goal is focused?
- What lifecycle events happened?
- What transaction is allowed right now?
- What irreversible action needs confirmation or review?

The agent should decide:

- Whether to ask a clarifying question.
- Whether minimal reconnaissance is needed to draft a better goal.
- What next action advances the goal.
- Whether the goal is plausibly complete enough to request auditing.
- How to respond to auditor feedback.

### 7.2 Hard Invariants

The following behaviors remain runtime-enforced:

1. **User-confirmed discussion creation.** A durable goal from `/goals` or `/sisyphus` is created only after `propose_goal_draft` confirmation.
2. **Explicit direct set creation.** `/goals-set` and `/sisyphus-set` are user-only shortcuts that create immediately from the supplied objective.
3. **No hidden direct creation.** `create_goal` remains rejected or unavailable as a normal agent path.
4. **Mode consistency.** A draft proposal cannot silently change `/goals` into Sisyphus or `/sisyphus` into a regular goal.
5. **Stale continuation protection.** A queued continuation for an old goal cannot perform work for a different current goal.
6. **Human-owned focus.** The agent cannot silently switch focus between open goals.
7. **Completion audit.** `complete_goal(status="complete")` archives only if the independent auditor returns exactly one approving marker.
8. **Path safety.** Goal files and archives must remain under expected `.pi/goals` paths.
9. **Post-stop transaction boundary.** After pause, abort, approved completion, or applied tweak, the same turn should not continue substantive work.
10. **No hard cost control/cap lifecycle.** Resource-control is outside this runtime; auto-continue uses semantic stop conditions and the empty-turn guard.
11. **Archive/delete safety.** Terminal lifecycle operations must not destroy unrelated files or resurrect stale state.

### 7.3 Soft Guidance

The following behaviors should move from hard runtime gates to prompt/skill guidance:

1. **Drafting should usually ask one focused question.** But a fully specified request may proceed directly to draft proposal.
2. **Drafting should usually avoid workhorse tools.** But minimal reconnaissance is allowed if it improves the goal contract and does not begin substantive execution.
3. **Active goals should focus on work tools.** But asking the user a real clarifying question is allowed when blocked or ambiguous.
4. **Repeated `get_goal` is discouraged.** Tool response can nudge the agent toward work, but should not hard-stop the turn.
5. **Tweak drafting should avoid task execution.** But reading relevant context may be acceptable before applying a goal tweak.
6. **Sisyphus discipline is prompt/criteria based.** It should not rely on step-count machinery.

## 8. Proposed Architecture

### 8.1 Layer 1: Goal Ledger

A new append-only JSONL ledger records lifecycle facts.

Candidate path:

```text
.pi/goals/goal_events.jsonl
```

Initial event types:

```ts
type GoalLedgerEvent =
  | { type: "goal_created"; goalId: string; objective: string; sisyphus: boolean; autoContinue: boolean; at: string }
  | { type: "goal_focused"; goalId: string; reason: string; at: string }
  | { type: "goal_unfocused"; reason: string; at: string }
  | { type: "goal_paused"; goalId: string; reason: string; suggestedAction?: string; at: string }
  | { type: "goal_resumed"; goalId: string; reason: string; at: string }
  | { type: "goal_tweaked"; goalId: string; changeSummary: string; at: string }
  | { type: "completion_requested"; goalId: string; summary?: string; at: string }
  | { type: "audit_started"; goalId: string; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "audit_result"; goalId: string; verdict: "approved" | "disapproved" | "error"; report: string; at: string }
  | { type: "goal_completed"; goalId: string; archivePath?: string; at: string }
  | { type: "goal_aborted"; goalId: string; reason: string; archivePath?: string; at: string };
```

Ledger requirements:

- Append-only writes.
- Tolerate missing ledger for legacy projects.
- Include enough information for debugging and deterministic summaries.
- Avoid storing secrets.
- Preserve ordering by file order and timestamp.
- Malformed lines must not crash normal use; they should be reported in diagnostics.

### 8.2 Layer 2: Goal Documents

Existing active goal markdown files remain user- and agent-readable documents.

Their role changes from "primary state machine record" to "living goal document".

Each document should expose:

- Objective.
- Success criteria.
- Boundaries and constraints.
- Current lifecycle status.
- Progress notes.
- Latest pause/blocker, if any.
- Latest auditor feedback, if any.
- Next suggested action, if known.

Machine reconstruction should prefer ledger events and explicit frontmatter fields over prose.

### 8.3 Layer 3: Runtime Transaction Tools

The runtime keeps tools for irreversible transitions:

- `propose_goal_draft`
- `get_goal`
- `complete_goal`
- `pause_goal`
- `abort_goal`
- `apply_goal_tweak`
- legacy `create_goal` rejection
- legacy `step_complete` no-op

Tool implementations should be transaction-oriented:

- validate transaction identity;
- append ledger event;
- update goal file;
- update focus if needed;
- update UI;
- return concise result.

The runtime should not try to encode every strategy rule as a gate.

### 8.4 Layer 4: Prompts and Skills

Prompts provide the agentic operating protocol:

- How to draft.
- How to execute.
- How to audit before requesting completion.
- How to handle Sisyphus style.
- How to respond to blockers.
- How to incorporate auditor rejection.

Future skills may split this strategy out of the core extension:

- `goal-draft`
- `goal-execute`
- `goal-sisyphus`
- `goal-finalize`
- `goal-auditor-review`

The extension should eventually have shorter prompts that reference these skills or embed concise strategy blocks.

### 8.5 Layer 5: Independent Reviewer Agents

The existing auditor becomes the first reviewer agent.

Future reviewer roles could include:

- completion auditor;
- risk reviewer;
- release reviewer;
- stale-goal summarizer;
- plan critic.

Reviewer outputs should be written to the ledger and summarized into future prompts.

## 9. Functional Requirements

### FR1: Append Goal Lifecycle Events

The system must append durable ledger events for all important lifecycle transitions.

Minimum events for first implementation:

- goal created;
- focus changed;
- goal paused;
- goal resumed;
- goal tweaked;
- completion requested;
- auditor result;
- goal completed;
- goal aborted.

Acceptance criteria:

- Every successful lifecycle transaction has a corresponding JSONL event.
- Auditor rejection also writes an event.
- Existing behavior remains unchanged during the shadow-log phase.

### FR2: Reconstruct Goal Context from Ledger

The system must provide a pure reconstruction function that turns ledger events into a summary state.

Acceptance criteria:

- Reconstruction identifies latest focus event.
- Reconstruction identifies latest auditor result per goal.
- Reconstruction identifies terminal events.
- Reconstruction works with empty or missing ledger.
- Reconstruction handles malformed lines according to documented policy.

### FR3: Deterministic Compaction Summary

The system must provide a deterministic goal summary for compaction and post-compaction recovery.

Acceptance criteria:

- Summary includes focused goal, open goals, status, objective, latest lifecycle events, and latest auditor result.
- Summary does not depend on LLM summarization.
- Summary remains useful after long sessions.
- Tests cover active, paused, no-focus, multi-goal, and auditor-rejected cases.

### FR4: Durable Auditor Feedback

Auditor results must become durable future context.

Acceptance criteria:

- `completion_requested` is logged before running the auditor.
- `audit_started` is logged with selected config when known.
- `audit_result` is logged for approval, disapproval, no marker, both markers, model error, config error, and abort.
- If disapproved, the next goal prompt includes the auditor's objections or a concise summary.
- If approved, completion proceeds and `goal_completed` is logged.

### FR5: Relax Drafting Strategy Gates

The system should stop enforcing behavioral drafting strategy as hard runtime state.

Acceptance criteria:

- Fully specified user requests can reach `propose_goal_draft` without requiring a synthetic question gate.
- Minimal read-only reconnaissance during drafting is allowed when used to improve the goal contract.
- Substantive task execution before confirmation remains discouraged by prompt and experiments, not blocked by broad runtime gates.
- User confirmation remains required before a durable goal starts.

### FR6: Relax Active-Goal Conversation Gates

The system should allow the agent to ask real clarification questions during active goals when needed.

Acceptance criteria:

- Active-goal prompts still prefer concrete work tools.
- Question-like tools are not hard-blocked solely because a goal is active.
- `pause_goal` remains the correct structured channel for real blockers.
- Experiments verify that the agent does not use questions as an excuse to avoid obvious next work.

### FR7: Replace Repeated `get_goal` Block with Nudge

Repeated `get_goal` calls should not hard-stop a turn.

Acceptance criteria:

- The tool may include a warning such as "You already inspected this goal; prefer work tools now."
- The runtime does not set post-stop state solely because of repeated `get_goal`.
- Empty-turn auto-continue protections still prevent infinite no-progress loops.

### FR8: Preserve Focus Ownership

The system must preserve human-owned focus.

Acceptance criteria:

- Explicit no-focus remains no-focus.
- Stale focus does not auto-focus a remaining single goal.
- Single-open auto-focus only applies when no explicit focus entry or ledger focus event exists.
- The agent has no normal tool to silently switch focus.

### FR9: Preserve Completion Integrity

Completion must remain protected by independent semantic auditing.

Acceptance criteria:

- Only a clean `<approved/>` permits archive/completion.
- `<disapproved/>`, no marker, both markers, errors, and aborts all reject completion.
- Rejected completion keeps goal open.
- Rejection is durable future context.

### FR10: Keep Backward Compatibility

Existing projects and goal files must continue to work.

Acceptance criteria:

- Missing ledger does not break `get_goal`, `/goal-list`, `/goal-focus`, `/goal-resume`, or completion.
- Existing `.pi/goals/active_goal_*.md` files remain readable.
- Existing archived goals remain untouched.
- Existing tests pass during shadow-log phase.

## 10. Non-Functional Requirements

### Reliability

- Ledger append must be robust and low-risk.
- A failed ledger append should not corrupt goal files.
- If append fails during a terminal transaction, the system should fail closed or report clearly.

### Observability

- Ledger path should be shown in diagnostics or docs.
- Lifecycle tool responses may mention relevant ledger/auditor context.
- Tests should inspect ledger content directly.

### Maintainability

- New modules should be small and pure where possible.
- Reconstruction should be unit-tested separately from pi runtime hooks.
- Prompt policy should be centralized, not scattered across gate reasons.

### Performance

- Ledger reading should handle reasonably long sessions.
- Compaction summary should guard recent events, e.g. last 20 or last 50 relevant events.
- No expensive auditor or reconstruction work should run on every trivial UI refresh.

### Security and Safety

- Ledger must not store tool outputs wholesale by default.
- Secrets should not be copied into ledger events.
- Goal file paths must remain constrained to `.pi/goals`.
- Auditor prompts must treat goal objective as untrusted user data.

## 11. Migration Strategy

### Stage A: Shadow Ledger

Add ledger writes without changing behavior.

- Current state machine remains authoritative.
- Ledger is used only for diagnostics and tests.
- This is low-risk and establishes durable facts.

### Stage B: Summary from Ledger

Use ledger to build deterministic summaries.

- Compaction summary uses ledger + active goal files.
- Runtime behavior still mostly unchanged.
- This proves ledger utility without destabilizing lifecycle.

### Stage C: Prompt-First Soft Gates

Relax soft strategy gates one by one.

- Update prompts.
- Update experiments.
- Remove exact string tests for soft rejection behavior.
- Keep hard transaction invariants.

### Stage D: Reconstruct Runtime from Ledger

Make ledger reconstruction participate in `loadState`.

- Prefer active files for canonical goal content initially.
- Use ledger for focus, latest auditor feedback, and terminal history.
- Gradually reduce reliance on session-only entries.

### Stage E: Remove Old State-Machine Residue

Delete or simplify unused gates and phase machinery.

- `questionsAsked`, normal-goal `draftId`, and drafting nudges are removed from the `/goal-set` confirmation path.
- Drafting tool gate becomes no-op or is removed.
- Repeated `get_goal` block removed.
- Prompt text no longer references runtime gates for soft behavior.

## 12. Rollout Plan

### Milestone 1: PRD and Design Freeze

Deliverables:

- This PRD.
- Architecture doc update.
- Gate inventory: hard invariant vs soft guidance.

Exit criteria:

- Maintainer agrees on direction.
- No runtime behavior changed.

### Milestone 2: Shadow Ledger

Deliverables:

- `extensions/goal-ledger.ts`.
- `tests/goal-ledger.test.ts`.
- Event appends in lifecycle transaction tools.

Exit criteria:

- `npm run check` passes.
- `npm test` passes.
- Existing experiments still valid.
- Ledger file is created and inspectable.

### Milestone 3: Deterministic Summary

Deliverables:

- `extensions/goal-compaction.ts`.
- Compaction hook integration.
- Tests for summary generation.

Exit criteria:

- Compaction summary contains enough context to continue goal work.
- No LLM-generated summary is required for goal state.

### Milestone 4: Auditor Feedback Loop

Deliverables:

- Completion request and auditor events.
- Rejection feedback in future prompts.
- Goal document update or summary injection for auditor objections.

Exit criteria:

- Auditor rejection is visible after compaction and restart.
- Agent can continue from rejection feedback.

### Milestone 5: Soft Gate Relaxation

Deliverables:

- Relax the required-question gate.
- Relax drafting workhorse block.
- Relax active question block.
- Replace repeated `get_goal` block with nudge.
- Simplify `/goals` and `/sisyphus` confirmation to a thin intent instead of a hidden draft-id/question-counter state machine.
- Add `/goals-set` and `/sisyphus-set` for direct user-owned creation when no drafting discussion is wanted.
- Update prompts and tests.

Exit criteria:

- User-confirmed creation still works.
- Vague topics still lead to clarification in experiments.
- Complete specs converge faster.
- Minimal drafting reconnaissance is allowed but substantive pre-confirmation execution is discouraged and caught by outcome tests.

### Milestone 6: Experiment Realignment

Deliverables:

- Updated experiment rubrics.
- New cases for ledger recovery and auditor feedback.
- Removed dependence on exact soft-gate rejection strings.

Exit criteria:

- Experiment suite evaluates product outcomes.
- New agentic behavior is stable across provider/model combinations.

### Milestone 7: Runtime Simplification

Deliverables:

- Simplified `syncGoalTools()`.
- Removed no-longer-needed phase gate code.
- Reduced prompt duplication.
- Updated architecture docs.

Exit criteria:

- `extensions/goal.ts` is smaller or at least conceptually split.
- Hard invariants remain tested.
- Soft behavior lives in prompts/skills/experiments.

## 13. Acceptance Criteria for the Whole Project

The project is successful when:

- Goal lifecycle facts are durably logged in append-only form.
- Goal context can be deterministically summarized after compaction.
- Auditor results are durable and influence future agent behavior.
- Creation, completion, focus, stale continuation, and path safety remain hard-protected.
- Drafting and execution feel less bureaucratic and more agentic.
- Fully specified goals do not require artificial questioning ceremony.
- Vague goals still generally produce clarification before commitment.
- Minimal context inspection during drafting is allowed when useful.
- Experiments focus on outcomes instead of exact tool-block mechanics.
- Existing goal files continue to work without manual migration.

## 14. Risks and Mitigations

### Risk: Agent starts task execution before goal confirmation

Mitigation:

- Prompt strongly says not to execute before confirmation.
- Experiments detect substantive file changes before confirmed goal creation.
- `propose_goal_draft` remains the only creation transaction.
- If needed, add lightweight detection/warning rather than broad hard blocks.

### Risk: Vague requests create weak goals too easily

Mitigation:

- Prompt requires concrete objective, success criteria, boundaries, constraints, and blocker rule.
- Confirmation dialog lets user reject weak drafts.
- Experiments include vague-topic cases.
- Auditor later rejects weak completion if goal was under-specified and not actually satisfied.

### Risk: Ledger and markdown disagree

Mitigation:

- Define precedence rules.
- During shadow phase, markdown remains canonical for goal content.
- Ledger drives lifecycle history and summary metadata.
- Tests cover disagreement cases.

### Risk: Ledger grows too large

Mitigation:

- Summaries guard recent events.
- Keep event payloads concise.
- Consider per-goal event files or archival later.

### Risk: Relaxing gates reintroduces old failures

Mitigation:

- Relax one gate at a time.
- Keep hard transaction gates.
- Update experiments before and after each relaxation.
- Use auditor feedback loop as semantic safety net.

### Risk: Multi-agent auditor becomes too expensive or slow

Mitigation:

- Auditor runs only on completion request.
- Configurable provider/model/thinking remains available.
- Fail closed on config/model errors.
- Ledger logs auditor errors for debugging.

## 15. Open Questions

1. Should the ledger be global (`goal_events.jsonl`) or per-goal (`events/<goalId>.jsonl`)?
   - Recommendation: start global for easier focus/pool reconstruction.

2. Should ledger append failure fail the lifecycle transaction?
   - Recommendation: for terminal transactions and auditor results, fail closed; for non-terminal diagnostics, warn and continue may be acceptable.

3. Should goal documents be automatically updated with latest auditor feedback?
   - Recommendation: yes, but only concise summaries; full report stays in ledger or tool output.

4. Should soft gate relaxation be configurable?
   - Recommendation: not initially. Avoid adding another settings surface until behavior stabilizes.

5. Should future skills be bundled in this package or separate pi skills?
   - Recommendation: start as bundled docs/prompts; split into skills if prompts become long or specialized.

## 16. Test Plan

### Unit Tests

- Ledger append/read/reconstruct.
- Malformed ledger handling.
- Compaction summary generation.
- Auditor event recording.
- Focus reconstruction.
- Terminal event handling.
- Legacy no-ledger fallback.

### Integration Tests

- Create goal -> ledger event -> active file.
- Pause/resume -> ledger events -> prompt summary.
- Completion rejected -> ledger event -> next prompt includes feedback.
- Completion approved -> ledger events -> archive.
- Compaction mid-goal -> deterministic summary includes current state.
- Multiple open goals -> no autonomous focus switch.

### Experiment Updates

Keep outcome tests for:

- vague goal clarification;
- full-spec goal fast path;
- Sisyphus ordered style;
- completion quality;
- abort/pause/clear;
- focus ownership;
- compaction recovery.

Remove or rewrite tests that require:

- mandatory question tool before proposal;
- absolute workhorse-tool ban during drafting;
- exact runtime block string for active goal questions;
- exact repeated `get_goal` block behavior.

## 17. Metrics

### Product Metrics

- Fewer false pauses or artificial questions on fully specified goals.
- Fewer brittle failures caused by tool visibility mismatch.
- Successful continuation after compaction without user restating context.
- Auditor rejection leads to meaningful follow-up work.

### Engineering Metrics

- Reduced number of hard `tool_call` block branches.
- Reduced prompt references to "runtime gate" for soft behavior.
- Increased test coverage for ledger reconstruction and summaries.
- Fewer exact-string tests for behavior that should be prompt-guided.

## 18. Implementation Notes

Initial files likely affected:

- `extensions/goal-ledger.ts` new.
- `extensions/goal-compaction.ts` new.
- `extensions/goal.ts` append ledger events and later simplify gates.
- `extensions/prompts/goal-prompts.ts` include ledger/auditor feedback.
- `extensions/goal-draft.ts` eventually relax soft validation.
- `extensions/goal-tool-names.ts` eventually simplify phase-based tool exposure.
- `tests/goal-ledger.test.ts` new.
- `tests/goal-prompts.test.ts`, `tests/goal-draft.test.ts`, `tests/goal-tool-names.test.ts` updates.
- `experiments/*` rubrics updates.

Implementation should proceed in small PRs. The first implementation PR should only add shadow ledger behavior and tests, with no soft-gate relaxation.

## 19. Decision Record

Proposed decisions:

- Use append-only ledger as durable lifecycle history.
- Keep existing goal markdown files for compatibility and human/model readability.
- Keep hard invariants for irreversible transactions.
- Move behavioral strategy to prompts, skills, auditor agents, and experiments.
- Introduce deterministic compaction summary from persisted artifacts.
- Relax soft gates only after ledger and summary infrastructure exist.

## 20. Appendix: Hard vs Soft Inventory

### Hard Runtime Invariants

- Confirm before durable goal creation.
- Reject direct hidden `create_goal` creation path.
- Reject draft proposals that mismatch the user's requested goal mode.
- Abort stale continuation identity.
- Preserve human-owned focus.
- Require independent auditor approval for completion.
- Keep path safety for active/archive files.
- Avoid resource lifecycle gates unless the product explicitly reintroduces them.
- Prevent same-turn substantive work after terminal/pause/tweak transaction.

### Soft Prompt-Guided Behaviors

- Ask one focused question during drafting when useful.
- Avoid unnecessary reconnaissance during drafting.
- Avoid substantive task execution before confirmation.
- Prefer work tools over repeated `get_goal` during active execution.
- Ask user only when there is a real blocker or ambiguity.
- Preserve Sisyphus ordering and patient style.
- Do not use proxy metrics as completion proof.
- Incorporate auditor feedback before retrying completion.
