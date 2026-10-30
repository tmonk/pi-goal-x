# Guided draft: the contract block belongs in `objective`

Status: implemented, awaiting review

## Problem

`/goal` and `/sisyphus` show the model a `=== Goal ===` block whose field labels are `Objective`, `Success criteria`, `Boundaries`, `Constraints`, `Verification contract` and `If blocked`. The guided-draft prompt then asks for a `propose_goal_draft` call without saying where that block goes.

`propose_goal_draft` accepts only `objective`, `tasks`, `token_budget`, `auto_continue`, `sisyphus` and `block_completion`, and closes its schema with `additionalProperties: false`. A model that reads the section labels as argument names therefore has its first proposal rejected with:

```
Validation failed for tool "propose_goal_draft":
  - boundaries: schema is false
  - constraints: schema is false
  - root: must not have additional properties
```

The draft survives because the model retries with the sections folded into the objective string, but every such draft costs a failed tool call and a visible error, and a weaker model can lose the section content on the retry.

## Observed frequency

Recorded locally over roughly three weeks of guided drafting across several unrelated repositories (`propose_goal_draft` results that failed validation): 34 rejections in 23 sessions. The rejected argument names were the ones the prompt prints:

| Rejected argument | Occurrences |
| --- | --- |
| `boundaries` | 11 |
| `constraints` | 10 |
| `verification_contract` | 7 |
| `success_criteria` | 5 |
| misspellings of `block_completion` and ad-hoc extras | 8 |

No provider or model dependency was visible: the same shape appeared with different providers, and the retry almost always succeeded once the sections moved into `objective`.

## Expected behavior

- The drafting prompt states that the whole block is written into the `objective` string, and names the arguments the tool actually accepts.
- The `objective` parameter description repeats the same fact for models that read schemas rather than prompts.
- Nothing else changes: `objective` remains the single source the goal record parses (`extractVerificationContract` and the questionnaire's section splitter keep working on the same shape).

## Out of scope

- Splitting the contract into separate tool parameters. That would duplicate what `goal-contract.ts` and `goal-questionnaire.ts` already parse out of the objective.
- Relaxing `additionalProperties: false`, which is what correctly surfaces genuinely wrong calls.
