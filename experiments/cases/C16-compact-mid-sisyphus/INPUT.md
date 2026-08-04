# C16 — compaction-then-resume mid sisyphus

## Behavior under test

While a 5-step sisyphus run is in progress, automatic compaction triggers
(compaction.json enabled, threshold=4000). Verify the post-compaction resync
mechanism: after compaction, the next agent_start injects a POST-COMPACTION
RESYNC block, the agent continues and completes the remaining steps, then
calls update_goal({status:"complete"}).

## Prompts

TURN: /sisyphus "Sisyphus 5 steps: 1) create f1.txt with 'one'. 2) create f2.txt with 'two'. 3) create f3.txt with 'three'. 4) create f4.txt with 'four'. 5) create f5.txt with 'five'. autoContinue: true."
