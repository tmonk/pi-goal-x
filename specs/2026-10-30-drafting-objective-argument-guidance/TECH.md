# Technical plan

## Change points

1. `extensions/goal-draft.ts` — one line in `goalFocusItems` and one in `sisyphusFocusItems`: the block goes into `objective`, and the accepted argument list is spelled out. The Sisyphus variant additionally names `Ordered steps` as a section of the objective.
2. `extensions/goal-drafting.ts` — the `objective` parameter description repeats that the contract sections live inside the string.
3. `tests/goal-draft.test.ts` — the existing `goalDraftingPrompt` test asserts both prompt lines for both focuses, so the guidance cannot be dropped silently.

## Why prompt-side

`extensions/goal-contract.ts` already extracts `Verification contract:` from the objective text, and `extensions/goal-questionnaire.ts` recognizes the `=== Goal ===` / `Objective:` / `Success criteria:` / `Boundaries:` / `Constraints:` section headers. The sectioned block inside `objective` is the intended shape; only the instruction was missing. Adding parameters instead would create a second, competing representation.

## Acceptance

- `npm run check`, `npm run lint` and `npm run test:unit` pass.
- `goalDraftingPrompt(topic, "goal")` and `goalDraftingPrompt(topic, "sisyphus")` both contain the objective-argument guidance.
- No change to the schema's accepted arguments, to validation messages, or to how a created goal stores its objective.
