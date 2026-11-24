# Issue and PR resolution

## Goal

Fix the open bugs that contributors reported or sent pull requests for, in one
reviewed change, and credit every contributor whose work it builds on.

## What users notice

- The goal tools stay the same in every goal state and during a guided draft,
  so the prompt cache is not thrown away when a goal starts, pauses or is
  drafted (#126, #130).
- Over RPC, starting a session no longer waits on a resume dialog nobody can
  answer (#132).
- During a guided draft, the agent sees only the draft instructions. It is no
  longer told to call `update_goal` or to stop work because goals are open
  (#129, #130).
- `update_goal_task` works with Google models (#128).
- The draft prompt says the contract sections go inside `objective`, which ends
  a common rejected tool call (#122).
- `/goal-resume some text` sends the text to the agent instead of dropping it.
- When open goals exist but none is focused, the agent does the user's work
  instead of refusing it (#135).
- A provider error that ends the run pauses the goal, so it no longer shows as
  running (#125).
- Ticking off a task no longer breaks the cached prompt prefix (#108, common
  case).

## Not in scope

- Translating dialog strings (#119). Parked.
- The README badge PR (#123). Closed.
- Goal-state changes other than task progress still reset the live tail (#108
  remains open for those).
