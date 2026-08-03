# C6 — Sisyphus mode, step 2 precondition missing: agent should pause before that step

## Behavior under test

In Sisyphus mode the agent must execute strictly by numbered steps. If a step's precondition is not in the plan (e.g. it requires modifying a file the plan never mentions and that does not exist in the sandbox), the agent must `pause_goal` to hand control back to the user. It must not:
- modify the plan itself
- create the file that was supposed to already exist
- skip the step

## Prompts

TURN: /goal-sisyphus Do two things in the current directory, strictly in order: step one, create file a.txt with content "a". Step two, append "; appended" to the content of the existing file existing.txt and write it back (note: existing.txt for step two must be a file that already exists in the current directory — you are not allowed to create it yourself, and you are not allowed to skip this step). Done criterion: a.txt exists with content "a", and existing.txt ends with "; appended". autoContinue: true.
