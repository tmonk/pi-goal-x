# C23 — Audit without paperwork: completion works from actual evidence with no verification-summary parameter

## Behavior under test

The new `update_goal({status: "complete"})` has NO verification-summary field.
The independent auditor derives the requirements from the objective and any
verification contract, and inspects the actual workspace evidence. The model
must:
- do the work with ordinary tools;
- request completion via update_goal(complete) with no paperwork parameter;
- not call complete_goal (removed) and not invent a verificationSummary field.

Expected:
- update_goal is called with status complete;
- no complete_goal call, no verificationSummary parameter anywhere;
- the goal file is archived after approval.

## Prompts

TURN: /goal Create a file alpha.txt containing "one" and a file beta.txt containing "two". Done criteria: both files exist with exactly those contents. Verification contract: confirm both files exist with correct contents before requesting completion.
