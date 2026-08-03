# C2 — `/goal-set` full spec should go straight to propose_goal_draft (no unnecessary back-and-forth)

## Behavior under test

When the user gives a **clear, verifiable, bounded** full description after `/goal-set`, the agent should not rigidly run 3 rounds of questions; it should confirm in one sentence and immediately call `propose_goal_draft`.

## Prompts

TURN: /goal-set In the sandbox current directory, create a new file called hello.txt whose content is "Hello, Goal!" on a single line (no extra blank lines). Done criterion: the file exists and its content is exactly that line. Do not modify any other files. No interactive questions needed. autoContinue: true.
