# Context baseline — main @ 2026-08-23 (post PR A/B/C)

Measured by `npm run context:measure`; artifact `experiments/context/baseline-main.json`.

Headline rows (chars):

| fixture | total | ext system | tool schemas | messages | hist checkpoints |
|---|---|---|---|---|---|
| active-regular-no-tasks | 8,920 | 1,441 | 7,262 | 202 | 0 |
| active-regular-10-tasks | 9,655 | 2,176 | 7,262 | 202 | 0 |
| active-regular-50-tasks | 9,945 | 2,466 | 7,262 | 202 | 0 |
| long-objective | ~12K | ~4.5K | 7,262 | ~208 | 0 |
| stale-checkpoint | 7,767 | 386 (GOAL STALE) | 7,262 | 76 | 0 |

Key facts this baseline pins:

1. Active goal tools cost ~7,262 serialized chars per request regardless of
   prompt content — previously unmeasured by B4.
2. Historical checkpoint payload is 0 on every fixture (issue #30 fix holds
   at the composed-request level).
3. Objective appears exactly once in every active-block request; verification
   contract exactly once when present.

Later optimization PRs (E/F) must show composed-request reductions against
this table while keeping these single-source invariants. Update
`baseline-main.json` only together with a rationale here.

## 2026-08-23 — PR E (single-source prompt) baseline update — RATIONALE

`baseline-main.json` regenerated after PR E's intentional prompt-composition
changes. Per-fixture composed-request deltas on task fixtures (all reduced):

| fixture | before | after | delta |
|---|---|---|---|
| active-regular-10-tasks | 9,655 | 9,476 | −179 |
| active-regular-50-tasks | 9,945 | 9,848 | −97 |
| current-contracted-task | 10,081 | 9,804 | −277 |
| nested-tasks | 10,098 | 10,001 | −97 |
| half-complete-tree | 9,565 | 9,386 | −179 |

Composition changes: current task rendered once (not duplicated as a generic
pending item); "Next pending" line only when nothing else is visible; UI
shortcut hint replaced by bounded-prompt note; update_goal schema surfaces
deduplicated to capability + boundary (the WHEN rules live once in the
canonical active-goal policy); get_goal gains verbose/include_history params
with minimal descriptions; lifecycle prose removed from the concise default.
Single-source invariants still hold exactly once per active request.

## 2026-08-23 — PR G (blocker Oracle) baseline update — RATIONALE

`update_goal` gains the optional `attempted_actions` parameter (bounded to 8
items × 240 chars), which adds +136 tool-schema bytes per request
(7,262 → 7,398). This is the deliberate cost of the opt-in blocker Oracle's
input surface; no other component changed. Steady-state non-Oracle requests
carry this parameter only in the schema, never in prompt text.

## 2026-11-26 — goal_control (revise/archive) baseline update — RATIONALE

`baseline-main.json` regenerated for a new, always-advertised model tool.
`goal_control({action: "revise" | "archive"})` lets an agent open the existing
`/goal-tweak` and `/goal-clear` confirmations instead of editing goal files or
creating a replacement goal. Two deliberate composed-request changes:

1. Tool schemas: +1,056 chars in every request, tools enabled or not
   (6,086 → 7,142; `tasks-disabled` 4,181 → 5,237). The schema is
   `action` + `change` + `objective` + `token_budget`; task-plan changes stay
   on `set_goal_tasks`, so no second task-tree schema is duplicated.
2. Canonical goal policy: the immutable-objective line now names the confirmed
   revision path (+72 chars) in requests that carry the active policy; the
   paused block adds the archive hint (+65 chars on `paused-goal` and
   `latest-auditor-rejection`). Blocked requests and the draft-only fixtures
   carry the tool schema and no policy line.

Nothing else moved: the objective, task list, snapshots, checkpoints and
message layout are byte-identical, so the single-source invariants still hold
exactly once per active request.
