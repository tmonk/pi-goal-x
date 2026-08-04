# C2 — full spec should go straight to create_goal (no unnecessary back-and-forth)

## Behavior under test

When the user gives a clear, verifiable, bounded full description, the agent
should confirm in one sentence and immediately call `create_goal` (the user
explicitly asked for a persistent goal via /goal). No interactive questions.

## Prompts

TURN: /goal In the sandbox current directory, create a new file called hello.txt whose content is "Hello, Goal!" on a single line (no extra blank lines). Done criterion: the file exists and its content is exactly that line. Do not modify any other files. No interactive questions needed. autoContinue: true.
