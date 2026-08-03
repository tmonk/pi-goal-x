# Refactor and Test Baseline

> **Historical document (superseded 2026-08-03).** This records the pre-0.22
> componentization baseline and intentionally contains removed drafting tools,
> modules, and commands. It is not current API or test documentation. See
> [`docs/architecture.md`](architecture.md) and the
> [2026-08-04 hardening plan](../specs/2026-08-04-goal-simplification-hardening/TECH.md).

This document records the current safety net for the `pi-goal` componentization work.

## Commands

```bash
npm test
npm run check
npm pack --dry-run
```

## Unit test coverage

The fast local suite uses Node's built-in `node:test` runner and currently covers the core modules across:

- `tests/goal-core.test.ts`
- `tests/goal-draft.test.ts`
- `tests/goal-policy.test.ts`
- `tests/goal-questionnaire.test.ts`
- `tests/goal-tool-names.test.ts`
- `tests/goal-record.test.ts`
- `tests/goal-files.test.ts`
- `tests/goal-pool.test.ts`
- `tests/goal-prompts.test.ts`
- `tests/goal-notifications.test.ts`
- `tests/goal-widget.test.ts`

## Extracted modules

`extensions/goal.ts` remains the orchestration layer. The following logic has been extracted and covered by tests:

| Module | Covered behavior |
|---|---|
| `extensions/goal-record.ts` | Goal creation, normalization/migration, usage cloning, persisted record shape |
| `extensions/goal-pool.ts` | Open-goal pool creation, deterministic ordering, explicit-null/stale focus resolution, disk-wins legacy migration, disk lifecycle reconciliation helpers, list and selector labels, unfocused summaries |
| `extensions/goal-core.ts` | Compact duration/token/status display, objective-title cleanup |
| `extensions/goal-draft.ts` | Lightweight confirmation prompt, draft summary, safe objective escaping, focus/mode gate, Sisyphus prompt-style guidance, drafting tool gate, multi-open draft creation allowance |
| `extensions/goal-policy.ts` | Creation/completion-from-active-or-paused, abort/pause/resume/clear policy, multi-open creation slot allowance, compaction reminder, full creation/completion reports |
| `extensions/goal-auditor.ts` | Independent pi auditor agent config parsing, prompt construction, approval marker parsing, and completion audit execution |
| `extensions/goal-questionnaire.ts` | Question normalization, duplicate id handling, option filtering, recommended-index validation, answer formatting, confirm/cancel mapping, `goal_question` and `goal_questionnaire` registration |
| `extensions/goal-tool-names.ts` | Published tool constants, active/paused/drafting tool lists, goal work-tool list, progress-tool list for empty-turn gating, post-stop allowlist, question-like tool detection |
| `extensions/prompts/goal-prompts.ts` | Active-goal, continuation, tweak-drafting, stale-checkpoint, and unfocused multi-open prompt text |
| `extensions/storage/goal-files.ts` | Safe goal paths, serialize/parse round trip, prompt-body disk edits, active-goal scans, active/archive writes |
| `extensions/widgets/goal-widget.ts` | Goal Beacon rendering, Sisyphus style label, status/path lines, blocker/suggested-action display, `+N open` and unfocused guidance |
| `extensions/widgets/goal-notifications.ts` | Widget-style notification text for goal lifecycle toasts |

## Refactor rule

1. Add or update tests before moving behavior.
2. Extract pure helpers or narrow adapter boundaries first.
3. Keep published tool names, slash commands, file formats, and UI semantics stable unless the user explicitly asks for a new public affordance such as `/goal-abort` or `abort_goal`.
4. Run `npm test` and `npm run check` after each slice.
5. Run `npm pack --dry-run` before release or packaging changes.

## Remaining runtime-sensitive areas

The following remain intentionally in `goal.ts` until a stronger mock `ExtensionAPI` / `ExtensionContext` harness exists:

- pi command registration;
- tool registration beyond the questionnaire pair;
- session event hooks;
- timers and auto-continue scheduling;
- live TUI widget rendering.

These areas are protected by TypeScript, focused unit helpers, and the end-to-end experiment harness rather than isolated component tests.

## Multi-goal focus test notes

The current suite specifically covers the multi-open goal architecture through pure helpers and storage seams:

- focus entry normalization in `tests/goal-record.test.ts`;
- active goal file scanning and invalid/symlink filtering in `tests/goal-files.test.ts`;
- goal pool sorting, focus resolution, explicit no-focus/stale focus behavior, disk-wins legacy fallback, disk lifecycle merge, list output, and selector labels in `tests/goal-pool.test.ts`;
- multi-open draft creation allowance, missing confirmation intent rejection, deprecated `draftId` compatibility, concrete-topic direct proposal guidance, and lightweight confirmation prompt text in `tests/goal-draft.test.ts`;
- no-focus prompt guidance in `tests/goal-prompts.test.ts`;
- continuation and compaction policy in `tests/goal-policy.test.ts`;
- auditor marker/config/prompt behavior in `tests/goal-auditor.test.ts`;
- drafting-phase lifecycle-tool suspension and progress-tool exclusion of `get_goal`, question tools, and draft proposal tools in `tests/goal-tool-names.test.ts`;
- focused widget `+N open` and unfocused `/goal-focus` guidance in `tests/goal-widget.test.ts`.

Release is intentionally separate from implementation validation. The local validation gate is `npm test`, `npm run check`, `npm pack --dry-run`, and `git diff --check`; `npm version`, `npm publish`, `git push`, and `pi update` only happen on explicit release request.
