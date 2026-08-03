# C11 — drafting tool whitelist (C3 schema gate)

## Behavior under test

During drafting, the agent is not allowed to call work tools such as bash/read/write/edit/grep/find/ls. A schema-level tool_call interceptor blocks these calls. The agent may only call propose_goal_draft or get_goal.

Expected: even if the agent wants to "recon the current directory", the framework rejects it. The final successful create must go only through propose_goal_draft, with no bash/read etc. calls at any point.

## Prompts

TURN: /goal-set In the current directory, create a README.md with content "Test C11". If the current directory already has a README file, skip it. First take a look at what the current directory looks like. autoContinue: true.
