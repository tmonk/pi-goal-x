# Implemented Borrowed Patterns

> **Historical document (superseded 2026-08-03).** This survey describes the
> earlier drafting interface and is retained as design provenance, not current
> product documentation. See [`docs/architecture.md`](architecture.md) and the
> [2026-08-04 hardening plan](../specs/2026-08-04-goal-simplification-hardening/TECH.md).

This document records external patterns that are actually implemented in `pi-goal` today.

## From pi-codex-goal

`pi-goal` uses several goal-loop stability patterns inspired by `pi-codex-goal`:

- **Goal-id continuation markers**: continuation prompts include a goal id so stale prompts can be detected.
- **Context interceptor**: stale continuation context is neutralized instead of letting an old goal keep driving the agent.
- **Abort pause**: user abort / Ctrl-C pauses the active goal rather than leaving it in a misleading active state.
- **Disk-backed active goal file**: the current objective is materialized on disk and can be audited outside the chat.

## From pi-autoresearch

`pi-goal` uses several autonomous-loop safety patterns inspired by `pi-autoresearch`:

- **Empty-turn gate**: auto-continue does not advance when the agent did no meaningful goal-work tool activity.
- **Post-compaction reminder**: after compaction, the next agent turn is reminded to re-read the objective and continue from actual artifacts/state.

## pi-goal-specific work

The current extension also adds behavior specific to goal drafting and lifecycle safety:

- **Intent-before-run**: `/goals` and `/sisyphus` start a drafting discussion instead of immediate execution.
- **Direct set shortcut**: `/goals-set` and `/sisyphus-set` immediately create a goal when the user already knows the final objective.
- **Confirm-before-commit for discussions**: `propose_goal_draft` is the normal discussion-based creation path; `create_goal` stays hidden.
- **Sisyphus as style**: `/sisyphus` and `/sisyphus-set` use the same lifecycle and tools as regular goals; they only change drafting/continuation wording and completion expectations.
- **Full draft confirmation and creation output**: draft confirmation uses a plain-text report, and after confirmation the finalized objective is printed directly into the conversation.
- **Full completion output**: completion prints a report directly into the conversation, including optional evidence and full goal details.
- **Built-in question tools**: `goal_question` and `goal_questionnaire` provide package-local user-dialogue tools with `goal_` prefixes.
- **Centralized tool names**: published tool names and allowlists live in `goal-tool-names.ts`.
- **Questionnaire componentization**: normalization, answer formatting, proposal confirmation, and question-tool registration live in `goal-questionnaire.ts`.
- **Widget module split**: the above-editor Goal Beacon and widget-style notification text live under `extensions/widgets/`.
- **Record/prompt/storage split**: goal record normalization, prompt construction, and disk serialization now live in separate tested modules instead of the orchestration file.

## Current validation

Run locally:

```bash
npm test
npm run check
npm pack --dry-run
```
