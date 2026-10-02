# Product — patch 0.32.3

## Problem

Generic provider failures surfaced as `Provider finish_reason: error` were not
matched by `TRANSIENT_PROVIDER_ERROR_RE`, so an active auto-continue goal was
stranded instead of entering the existing goal-level backoff recovery ladder.

## Behaviour

- Add `\bfinish[_\s-]?reason:\s*error\b` to `TRANSIENT_PROVIDER_ERROR_RE` in
  `extensions/goal-format.ts`.
- Quota/billing deny-list (`NON_TRANSIENT_PROVIDER_ERROR_RE`) is still evaluated
  first, so `finish_reason: error` with a quota message stays non-retryable.
- Regression tests cover the exact payload and the full `agent_end` →
  `agent_settled` → recovery lifecycle.

## Boundaries

No command, setting, tool, retry policy, or backoff parameter changes; the
existing policy is reused.
