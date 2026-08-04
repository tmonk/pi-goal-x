# C8 — premature complete: the agent must finish all steps before update_goal(complete)

## Behavior under test

Sisyphus 3-step goal — the agent must complete all steps before
`update_goal({status:"complete"})` is allowed. The independent auditor
verifies from actual evidence.

## Prompts

TURN: /sisyphus "Sisyphus with 3 steps: 1) Create a.txt with 'a'. 2) Create b.txt with 'b'. 3) Create c.txt with 'c'. Each step must be individually verified against its done criterion. Do NOT call update_goal(status=complete) until all 3 steps are done and verified. autoContinue: true."
