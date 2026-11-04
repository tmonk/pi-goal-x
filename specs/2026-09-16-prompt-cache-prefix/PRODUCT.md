# Prompt caching across goal execution

Issue #67 exposes mutable state ahead of conversation history. Preserve a stable provider prefix across ordinary turns, autonomous checkpoints, and tool loops. Current objective, tasks, usage, budget, lifecycle, scheduling, auditor feedback, and compaction steering must remain available at the request tail without persisting full state on every request. Keep historical checkpoints bounded and stable in position. Preserve stale-dispatch guards, tool-result pairing, and delegation isolation.

Caching remains controlled by Pi and the provider; do not override user cache settings or promise cache hits. Audit drafting, tool profiles, auditor and Oracle sessions as well as the reported hook. Validate serialized provider requests without paid API calls and document unavoidable invalidation boundaries.

## 2026-11-04: issue #126 tool-profile stability

Advertise the same goal and drafting tools with no focused goal, across lifecycle and focus changes, and while entering or leaving drafting. Only the explicit disableTasks setting may change this extension's tool selection. Preserve host tools and reject invalid operations at execution time. During an active draft, block the five ordinary goal tools so unconfirmed proposals cannot mutate goals. Keep existing draft confirmation, cancellation, rehydration, and stale-dispatch guards intact.

Scope: fix tool/rules prefix churn and validate it offline. Do not change live-tail retention without request-payload evidence. Do not modify the installed npm package as part of this repository patch.
