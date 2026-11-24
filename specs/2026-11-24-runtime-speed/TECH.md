# Runtime speed and prompt caching: plan and results

Starting point: `main` at b512c86 (0.35.1). 1,291 tests pass.

## What was measured first

Everything below was measured on the same machine before any change. Numbers
are medians. "Before" is `main`, "after" is this branch.

| Area | How it was measured |
|---|---|
| Per-turn hooks over a growing session | New bench B11: 240 turns, three requests per turn, a task finished every eighth turn, history grows to 1,920 messages and 2.8 MiB. Runs the real handlers. |
| File operations per tool call and per turn | `experiments/bench/trace-ops.mjs` prints every sync fs call behind one tool call. B2 and B7 already count them. |
| Startup | Pi's own extension loader on `extensions/goal.ts`, 15 runs, with and without jiti's cache. |
| Prompt cache | `npm run context:cache-gate` (408 real-adapter scenarios, 1,000 transitions), `experiments/prompt-cache/simulate.ts`, tool and policy size. |

## What the measurements showed

1. **The history check ran on every request and grew with the session.**
   `LiveTailRetention.apply` turned every message into JSON and hashed it, on
   every request, to find out whether anything earlier had changed. At 2.8 MiB
   that was about 9 ms per request and 27 ms of every goal turn. It was the only
   hook that got slower as the session grew (B11 late/early: 4.9x).
2. **Every ordinary turn saved the goal file twice.** The turn-end flush wrote
   it, then `agent_end` locked, re-read and wrote it again with nothing new in
   it. Each save also rewrote the pool snapshot: 38 file operations per turn.
3. **Needless directory work.** Each lock made the lock folder twice, and each
   goal write made the goals folder and then checked it. About 3 operations per
   save.
4. **Startup loads about 850 KB of source in 108 modules.** About 70 KB of it
   is only used by `/goal-settings`, `/goal-status` and `/goal-recovery`.
5. **Prompt cache was already near its floor.** Production is 4% to 15% above
   a request with no goal text at all (simulate.ts). The tool definitions are
   about 1,900 tokens and the policy block about 650 tokens plus 170 for a ten
   task list. Every volatile value (usage, run counts, clocks, waits) already
   sits in the request-only tail. There was nothing left to gain from changing
   wording, and the wording is the contract with the model, so it is untouched.

## Changes

1. `goal-live-retention.ts`: keep a small snapshot of each message from the
   last request and compare against it. Short strings are kept as they are,
   strings over 4,096 characters as a length and a SHA-256, so memory stays
   small and big tool output is never held twice. Only new messages are copied.
   A message that cannot be copied (a cycle, a class instance) never matches, so
   it resets, exactly as an unserialisable one did before. Pi hands the hook a
   fresh `structuredClone` each request, so object identity cannot be cached.
2. `goal-service.ts`: `persist()` skips the write when the file on disk already
   holds what memory holds (compared with sorted keys, ignoring `updatedAt` and
   `revision`). This removes the second save at `agent_end`. Any real change
   still writes.
3. `file-lock.ts`, `goal-lock.ts`, `goal-root.ts`: make the lock folder only
   when the first create says it is missing; check the goals folder with one
   `lstat` instead of `mkdir` then `lstat`. External pools keep their checks.
4. `goal-commands.ts`: load the settings menu, controls dialog, status and
   recovery code when their command first runs.
5. Bench: `b11-session-turns.mjs`, `trace-ops.mjs`, the `speed` campaign, and
   B6 gate checks for B11 (file operations per turn, growth with history).
6. Tests: `goal-runtime-speed.test.ts` and `goal-request-stability.test.ts`.

## Results

| Measure | Before | After |
|---|---|---|
| Goal turn, first 20 of 240 (B11) | 4.7 ms | 2.1 ms |
| Goal turn, last 20 of 240, 2.8 MiB history (B11) | 32.4 ms | 6.7 ms |
| `context_with_system`, last turn (3 requests) | 27.1 ms | 5.1 ms |
| Growth, late over early | 6.8x | 3.2x |
| File operations per ordinary turn (B11) | 44 | 22 |
| File operations, task update | 24 | 21 |
| File operations, `create_goal` | 44 | 42 |
| File operations, uncontended lock | 4 | 2 |
| Extension load in Pi, jiti cache warm | 102 ms | 97 ms |
| Extension load in Pi, no cache | 2,184 ms | 2,015 ms |
| Source loaded at startup | 853 KB, 108 modules | 784 KB, 102 modules |
| Prompt cache gate | 408 scenarios pass | 408 scenarios pass, same deltas |
| Uncached input tokens (simulate.ts, 5 sessions) | 147,210 / 143,428 / 131,402 / 721,038 / 230,301 | identical |

The last two rows are the point of leaving the prompt text alone: they did not
move.

## Left alone, and why

- **Completion flow and questionnaire as lazy modules.** About 100 KB more
  would leave startup. The tests (`goal-audit-lifecycle`, `goal-drafting`) rely
  on the auditor starting and the proposal dialog opening in the same tick as
  the tool call. A lazy import adds a turn of the event loop. Not worth changing
  how those flows are ordered for a few milliseconds of startup.
- **Pool snapshot rewrite on every save (7 of 16 operations).** It is what lets
  a new session read the pool in two operations, and a stale snapshot would
  serve old task state. Deferring it trades a crash window for speed.
- **Keeping the pool cache after our own write.** It would save 3 reads per
  save, but another process's change would then wait for our next write to be
  noticed.
- **Prompt and tool wording.** See "What the measurements showed", point 5.
- **The 80 ms audit animation timer.** It only runs during an audit.

## Guard rails added

- B6 fails when file operations per goal turn pass 26, or when a late turn takes
  more than 3.5x an early one.
- `goal-runtime-speed.test.ts` fails when a turn saves the goal file twice, when
  a task update passes 25 file operations, when command-only modules load at
  startup, when startup source passes 800 KB, and when a 1,500 message history
  check takes 25 ms.
- `goal-request-stability.test.ts` fails when tool definitions differ between
  sessions or pass 8,000 characters, when the policy block or task list pass
  their size bounds, when usage, clock or revision leak into the policy or task
  list, and when pausing or changing tasks touches the tool list.

## Reproduce

```sh
npm run bench -- before speed     # on the base commit, with b11 copied in
npm run bench -- after speed
npm run bench:gate -- speed
node --import ./experiments/bench/bench-adapter-hooks.mjs --experimental-strip-types experiments/bench/trace-ops.mjs
```
