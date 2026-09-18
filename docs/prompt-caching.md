# Prompt caching

pi-goal-x preserves the provider's reusable prompt prefix during normal user turns, autonomous checkpoints, and tool loops. No extra extension setting is required. Pi's provider configuration still determines whether caching is enabled, its retention period, and model support.

The request layout is:

1. Host system prompt and tool schemas.
2. Conversation history, with each goal checkpoint normalized to a tiny, stable trigger in its original position.
3. One request-only goal-state message containing the current objective, tasks, lifecycle rules, usage, budget, scheduling state, and applicable recovery/auditor reminders.

Changing goal state never rewrites the system prompt or historical messages. The full goal-state message is not persisted into the session. Old checkpoints remain until Pi compacts history; retaining small markers avoids shifting the prefix on every continuation. Display-only auditor messages are consistently excluded, and tool calls stay adjacent to their results.

For Anthropic-style explicit caching, the extension moves Pi's existing cache_control breakpoint from the transient state message onto the preceding cacheable history block. The Bedrock equivalent moves the cachePoint. A contentless trailing message from the host, such as the effort-only marker Pi appends for `supportsMidConvoEffort` models, is skipped when locating that state message. Both preserve the configured TTL and do not add breakpoints. Payloads without an existing explicit marker—including caching disabled and implicit-cache providers—are unchanged. The extension does not set cache keys, enable paid extended retention, or replace provider defaults.

Execution tools already use an idempotent profile: goal progress, focus, and lifecycle changes do not change schemas. Explicit switches into/out of drafting and changes to disableTasks can change tools and legitimately rebuild the cache. Drafting messages are appended to conversation history. Isolated auditor and Oracle sessions already use fixed instructions/tool profiles and place goal-specific evidence in their user messages; their tool loops retain history. They have separate sessions and use Pi's cache defaults. Opting these sessions into project resources also opts into any behavior from those resources.

Cache reuse can still be interrupted by Pi compaction, branch/session changes, model/provider switches, other extensions changing earlier content, changed tool schemas, provider expiry, minimum-length or breakpoint-lookback limits, or routing. The extension cannot guarantee a hit rate or a particular cost reduction. The reported issue used Pi 0.85.1; this change is validated against the repository's supported installed SDK, without expanding its peer dependency range.

Validation includes consecutive request-prefix regressions; actual Anthropic, Anthropic-compatible Chat Completions, OpenAI Chat Completions and Responses serialization with short/long/disabled retention; Bedrock payload-shape checks; lifecycle/tool-pair safety tests; and full SDK parent/auditor/Oracle payload captures. These tests stop before HTTP dispatch. They verify request construction, not live provider hit rates.

Provider references: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) describes exact-prefix matching and explicit breakpoints; [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/) describes its automatic prefix cache and usage counters.
