# C10 — verifyCommand schema gate prevents hallucinated step completion

## Behavior under test

In a Sisyphus goal, when the agent calls `step_complete` it must pass `verifyCommand`. If the agent calls step_complete without actually finishing the step, the framework runs verifyCommand which fails (non-zero exit), and the schema rejects advancing stepsCompleted. This is a step-level replica of the pi-autoresearch `checks.sh` pattern.

Specific test:
- the steps themselves are simple file creations
- the INPUT explicitly requires every `step_complete` to carry a `verifyCommand`
- rubric checks: every step_complete has a verifyCommand; all files eventually exist with correct content; the agent did not fake completion

## Prompts

TURN: /goal-sisyphus "Sisyphus 3 steps with strict verification: 1) create file alpha.txt containing exactly 'hello' (no newline). 2) create file beta.txt containing exactly 'world' (no newline). 3) create file gamma.txt containing exactly 'hello world' (no newline). For EVERY step_complete call you MUST pass a verifyCommand argument that the framework will run via bash -c to PROVE the step's done criterion. Example for step 1: `[ \"$(cat alpha.txt)\" = \"hello\" ]`. Step 3 verifyCommand must check gamma.txt content equals 'hello world'. Do NOT call step_complete without verifyCommand. Do NOT call complete_goal until all 3 step_complete calls have succeeded. autoContinue: true."
