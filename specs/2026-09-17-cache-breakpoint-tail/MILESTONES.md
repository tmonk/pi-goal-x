# Implementation log

- Observed #67's symptom on 0.31.6 with a focused goal on `claude-opus-5`:
  `cacheRead` frozen across consecutive requests while `liveContent` changed
  length every request. Ruled out TTL expiry, aside sessions, lazy MCP tool
  loading, and thinking blocks by controlled comparison before reading code.
- Instrumented `before_provider_request` in an isolated working directory to
  record breakpoint positions and evaluate the existing guard. The guard
  reported `last.role=system`, so relocation never ran and the breakpoint
  stayed on the volatile block.
- Established that the trailing message is Pi's own: it survives
  `--no-extensions`, and a four-model sweep showed it on `claude-opus-5` and
  `claude-fable-5-1` but not on `claude-sonnet-5` or `claude-haiku-4-5`.
  First attributed it to payloads carrying `output_config`; reading Pi's
  Anthropic transport showed `insertThinkingLevelMessages`, gated on
  `supportsMidConvoEffort`, which appends one effort-only marker after the
  message Pi has already marked for caching and places others ahead of
  assistant turns. The built-in catalog sets the flag on exactly the two
  affected models. The mid-conversation markers were already tolerated by the
  role filter and the empty-content skip; only the trailing one reached the
  `at(-1)` guard.
- Confirmed the fault is specific to explicit breakpoints. On
  `openai-responses` the message field is `input`, no `cache_control` appears,
  and the volatile block sits strictly at the tail, so the prefix still
  extends; `cacheGoalHistory` already declines those payloads.
- Implemented `tailMessageIndex` and derived both loops from it. Confirmed the
  new regression fails against the previous implementation (3 pass, 1 fail)
  and passes with the change.
- Validation: `npm run check`, `npm run lint`, `npm run test:all` (1,008
  passing tests across 79 files), `npm run test:selfcheck` (957), `npm run
  context:gate` (24 fixtures, baseline unchanged), `npm run
  context:provider-check` (6 real SDK payloads, no network), and the remaining
  CI steps: ranking updater tests, `npm pack --dry-run`, `npm audit
  --omit=dev`, `npm run bench:gate:naf`. No paid provider requests were made;
  these checks verify request construction rather than live hit rates.
