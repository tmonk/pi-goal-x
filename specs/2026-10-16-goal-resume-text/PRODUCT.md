# Product: /goal-resume optional trailing text delivered to the agent verbatim

## Status

Confirmed change (2026-10-16), implemented.

## Motivation

`/goal-resume` currently ignores any trailing text. A user who types
`/goal-resume focus on the failing test first` gets the text silently
dropped, which reads like it was sent to the agent but was not.

## Behavior

- `/goal-resume <text>`: the trailing text is delivered to the agent
  **verbatim** as a plain user message — no prefix, no wrapping, no goal
  metadata attached. Delivery uses the same pattern as the goal-drafting
  flow (`sendUserMessage(text, { deliverAs: ctx.isIdle() ? "followUp" :
  "steer" })`).
- `/goal-resume` with no argument (or whitespace-only text) behaves
  byte-identically to today: nothing is sent to the agent.
- Text is delivered **before** the resume logic, including before every
  early-return path (no focused goal, focus-picker cancellation, scheduler
  resume returning false), so the text is never dropped.
- A delivery failure (`sendUserMessage` throwing) shows an error notification
  and does **not** block the resume; resume continues normally.

## Boundaries

No resume semantics, notification text, or ledger events change.

## Ordering rationale

Ordering is best-effort and differs by path. Busy path: the steered message
enters pi's pending queue, so `sendQueuedContinuation`
(`extensions/goal-runtime.ts`) waits for it (`!ctx.hasPendingMessages() &&
ctx.isIdle()`). Idle path: the delivered message starts a user turn directly
(`hasPendingMessages()` only counts queued steer/followUp messages), and
`agent_start` → `GoalScheduler.begin()` (`extensions/goal-scheduler.ts`)
cancels the armed kickoff timer. If a 0 ms kickoff dispatch still wins the
race, the user text is queued as a followUp inside that run — ordering may
invert, but no message is lost.
