# Prompt caching

pi-goal-x preserves the provider's reusable prompt prefix during normal user turns, autonomous checkpoints, and tool loops. No extra extension setting is required. Pi's provider configuration still determines whether caching is enabled, its retention period, and model support.

The request layout is:

1. Host system prompt and tool schemas.
2. Conversation history, with each goal checkpoint normalized to a tiny, stable trigger in its original position.
3. Request-only goal text, replayed at verified history anchors when safe: a policy block (rules, objective, contract, limits, status), the task list as append-only snapshots, and a last block of text that exists only for this request (usage, run counts, scheduling waits, stall notes and one-shot reminders).

Changing goal state never rewrites the system prompt or historical messages. The full goal-state message is not persisted into the session. Old checkpoints remain until Pi compacts history; retaining small markers avoids shifting the prefix on every continuation. Display-only auditor messages are consistently excluded, and tool calls stay adjacent to their results.

Goal context filtering and live-state tails use Pi's `context_with_system` event, preserving system and tool deltas in their original positions. Parent and delegated sessions use this hook from their first request.

For Anthropic-style explicit caching, the extension moves Pi's existing cache_control breakpoint from the transient state message onto the preceding cacheable history block. The Bedrock equivalent moves the cachePoint. Both preserve the configured TTL and do not add breakpoints. Payloads without an existing explicit marker—including caching disabled and implicit-cache providers—receive no marker changes. The extension does not set cache keys, enable paid extended retention, or replace provider defaults.

The goal tool list is fixed. Goal progress, focus, lifecycle changes and drafting do not change it; the drafting tools are always listed and the goal tools are blocked during a draft instead of removed. Only a change to disableTasks changes the list and rebuilds the cache. Drafting messages are appended to conversation history. Isolated auditor and Oracle sessions already use fixed instructions/tool profiles and place goal-specific evidence in their user messages; their tool loops retain history. They have separate sessions and use Pi's cache defaults. Opting these sessions into project resources also opts into any behavior from those resources.

Cache reuse can still be interrupted by Pi compaction, branch/session changes, model/provider switches, other extensions changing earlier content, changed tool schemas, provider expiry, minimum-length or breakpoint-lookback limits, or routing. The extension cannot guarantee a hit rate or a particular cost reduction. The supported host range is Pi 1.4+ within 1.x, with Node 22.19 or newer. Development dependencies pin Pi 1.4.0.

Pi 1.4 prepares custom-triggered turns through the same public startup protocol as user prompts. The extension leaves structured prompt and tool deltas intact, including additional sections supplied by other extensions. Direct creation, drafting, resume and reload use the host's native prompt preparation from the first request. Toggling disableTasks still rebuilds the prefix.

Validation includes consecutive request-prefix regressions; actual Anthropic, Anthropic-compatible Chat Completions, OpenAI Chat Completions and Responses serialization with short/long/disabled retention; Bedrock payload-shape checks; lifecycle/tool-pair safety tests; and full SDK parent/auditor/Oracle payload captures. These tests stop before HTTP dispatch. They verify request construction, not live provider hit rates.

Provider references: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) describes exact-prefix matching and explicit breakpoints; [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/) describes its automatic prefix cache and usage counters.

Active requests split goal text by how often it changes.

- **Policy block**: rules, objective, contract, limits and status. When it changes (pause, resume, settings, budget or run limits), the new block is appended with a line saying it supersedes the earlier ones. Nothing before it moves, so the cached prefix survives. When the policy goes back to a text already in history (pause, then resume), a one-line pointer to that block is appended instead of the full text, so long goals with many pauses never hit the block limit. Every request that still has older policy blocks in history ends with a line saying only the latest one applies.
- **Task list**: kept as snapshots. A change appends a new snapshot; an unchanged list adds nothing.
- **Request-only text**: usage, run counts, scheduling waits, stall notes and one-shot reminders go at the very end of each request and are never kept. They clear by simply not being sent again, so nothing stale is left in history.

When a goal ends, a draft is open, a checkpoint goes stale or only unfocused goals remain, the blocks already sent stay where they are and one short block says the goal blocks no longer apply (`[PI GOAL ENDED]` or `[PI GOAL ON HOLD]`). Dropping them would shift everything after them and miss the cache once. A goal that starts after one of these needs no reset either: its policy block supersedes the rest, and its task list is sent again.

Retention starts over (one uncached request) only when one goal's scope changes straight into another (a different goal, or a changed objective, verification contract or sisyphus mode), history is rewritten (compaction, session-tree moves, a reload), a tool-result boundary is unsafe, or a bound is hit: at most 12 policy blocks, 48 tails and 24 KiB of task-list snapshots per session, across at most 16 session/model identities. No full-state tails are persisted. Older snapshots are historical, and the current policy takes precedence over cache reuse.

Measured with `experiments/prompt-cache/simulate.ts` (request construction only, not live provider hit rates; 128-token blocks, cached reads priced at a tenth). Uncached input tokens, 0.35.0 against this layout:

| session | before | after |
|---|---|---|
| 60 steady turns | 191,209 | 147,210 |
| typical (tasks, one pause, waits) | 227,991 | 143,428 |
| three pauses | 191,736 | 131,402 |
| heavy tool output, two pauses | 1,218,284 | 721,038 |
| 150 turns | 348,024 | 230,301 |

Big prefix breaks in these sessions went from one or two to none. The floor with no goal text at all is within about 10% of the new numbers, so little is left to gain from the goal text.

Pi hands the extension a fresh copy of the history on every request. To tell whether anything earlier changed, the extension compares each request with a snapshot of the last one (text up to 4,096 characters as it is, longer text as a SHA-256). Only new messages are copied, so the check stays cheap as a session grows: about 7 ms of a goal turn at 2.8 MiB of history, where hashing every message took 27 ms.

Explicit-marker relocation skips all retained live text and tolerates Pi's trailing effort-only messages. Another extension's content-bearing suffix is left alone. Changing models/providers starts a separate retention identity. A host that gives no session id is keyed by its session object. Only a request with no session at all retains nothing.

Validation now includes advancing SDK request chains, combined effort-marker/retention regressions, 1,000-turn growth bounds and a 64 KiB–4 MiB history-cost gate. These are request-construction and CPU measurements, not live provider hit-rate claims.

## Seeing the real hit rate

`/goal-status verbose` shows how much of each request the provider read from its cache this session, taken from the usage record on every assistant message (requests under 2,000 tokens are ignored). If the rate falls to nearly zero on two requests in a row after working well, a warning says so. Something early in the prompt changed: another extension, a model or provider switch, compaction, or the cache expired. Providers that do not report cache reads show nothing.

The usage line (`Goal snapshot: …`) is only sent with a token budget or when `showContextUsage` is on. It changes every request and is never cached, and a bare running total can read like context exhaustion.
