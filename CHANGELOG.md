# Changelog

All notable changes to pi-goal-x are documented here.

## [Unreleased]

### Fixed

- **Empty-turn auto-continue loop** — `agent_end` clears the turn_end continuation timer, then `agent_settled` re-queued with `force: true` even when the run called no goal-work tools. A no-tool reply (for example "Paused. No action." after `/goal-resume`) therefore injected another checkpoint forever. Auto-continue now waits for meaningful work in that agent run. User resume, goal creation, and session kickoff still start the first continuation.

## [0.31.2] — 2026-09-08

### Changed

- Simplified the README and package description to explain goal creation, regular and Sisyphus goals, tasks, completion auditing, commands, and core settings.
- Update the Pi extension ranking before each release, including both badge themes and README accessibility text. Release retries reuse the recorded ranking; dry runs do not update it. No daily schedule is used.
- Include badge images in the npm package.

## [0.31.1] — 2026-09-08

### Fixed

- **Guided drafting on RPC and browser hosts (#45, #47, PR #46)** — native select/input dialogs retain question and proposal context, recommendations, custom answers, and auditor selection. Missing or incompatible terminal UI no longer crashes drafting or flashes a spurious web-host error. Cancelled, unavailable, and failed dialogs never confirm unseen proposals; errors preserve the draft and explain the next step.
- **Audit tool-result pairing (#48)** — audit transcript messages wait until the agent settles and never trigger a model turn. Display-only audit events are excluded from provider context, including events already stored in affected histories, preventing duplicate or unpaired tool results without editing session files. Live audit progress and ledger evidence remain available.
- **Forked subagent prompt collisions (#49)** — delegated children no longer initialize goal tools, state, accounting, or continuation loops. Fresh, forked, resumed, and nested children retain ordinary conversation while leaving parent goal ownership untouched.

## [0.31.0] — 2026-09-07

### Performance and token overhead since 0.30.5

- **38% smaller extension-added model context** across 14 active workflows: 145,134 → 89,993 serialized characters. This estimates input-token overhead; it is not a claim of 38% fewer total billed tokens.
- **6× faster expanded dashboard rendering** with 50 long tasks: 1.71 → 0.28 ms.
- **Over 99.9% less time to display recent activity** with 100,000 history events: 11.9 → 0.003 ms. This measures indexed warm reads, not initial history loading.
- Direct comparisons use identical fixtures and SDK 0.84.1. Raw measurements, limitations and reproduction are in `specs/2026-09-07-release-0-31-0/`.

### Changed

- Reduced model context through applicable tool profiles, shared guidance, bounded objective/task excerpts, and lossless `get_goal` detail pages. Existing tool names and single-task forms remain supported.
- Added ordered atomic `update_goal_task` batches, with full rollback on invalid transitions and individual ledger events.
- Indexed ledger activity, audit and Oracle state; reused task presentation across usage updates; removed full-history copies on append. Version 3 checkpoints rebuild older/corrupt derived data, retain Oracle results and use correct Unicode byte offsets.
- Buffered writes now reject competing revisions before overwriting state; completion audits require successful persistence. Isolated auditor/Oracle sessions release resources, and Oracle requests share the parent runtime and cancellation path.
- Corrected SDK context measurement and added isolated before/after runtime, allocation, context, provider-payload, and capped live evaluation evidence under `specs/2026-09-07-runtime-token-optimization/`.
- Added bounded caches for settings, task content, detail pages and text layout; streamlined task updates, storage reads, session diagnostics and auditor previews. Consolidated auditor instructions and bounded oversized post-compaction task context while retaining lossless retrieval.

### Verified

- 923 tests, TypeScript, lint, context and performance gates pass. SDK 0.83.0 and 0.84.1 each pass 888 serial compatibility tests and six provider-payload cross-checks.
- Regular/Sisyphus goals, drafting, tasks, verification, independent auditing, Oracle, budgets, controls, saved data and recovery remain supported.

## [0.30.5] — 2026-08-25

### Fixed

- **Provider-side aborts no longer pause goals mid-outage** — an assistant
  message with `stopReason:"aborted"` arriving without a user abort signal
  (transport-level termination during a provider outage) now routes into the
  bounded unbounded recovery instead of pausing the goal. All three lifecycle
  handlers (`message_end`, `turn_end`, `agent_end`) are signal-aware: only a
  genuine user Esc (`ctx.signal.aborted`) pauses.
- **429 rate limits are recoverable** — HTTP 429 payloads ("Provider returned
  error ... temporarily rate-limited upstream") were not classified as
  transient, so recovery never scheduled. Classification now covers `\b429\b`
  and rate-limit wording; quota/billing exhaustion (`insufficient_quota`,
  `out of budget`, usage-limit errors) remains fail-fast via a new exclusion
  list that wins over transient matches.

### Added

- Live-pi e2e scenario for sustained 429 outages and a full real event-ordering
  regression test (`message_end → turn_end → agent_end → agent_settled`)
  proving provider-side aborts engage recovery without pausing.

## [0.30.4] — 2026-08-25

### Added

- **Live-pi e2e regression guard for network-error recovery** —
  `tests/e2e/network-recovery-rpc.test.ts` drives a real pi subprocess
  against a mock provider returning the exact reported failure
  (`503 server_error: Upstream request failed: Endpoint is unavailable.`)
  and asserts the full unbounded backoff loop engages: escalating
  "(recovery N, unbounded)" notifications, checkpoint continuation
  delivery after settle. Skips automatically when the `pi` CLI is absent.

### Verified

- Field report of "unlimited retry not working" reproduced against real pi
  on this tree: classification, scheduling, escalation, and checkpoint
  delivery all work; the failing session predated 0.30.3 (extensions load
  once per session). Restarting sessions loads the fixed behavior. See
  `specs/2026-08-23-network-error-backoff/MILESTONES.md`.

## [0.30.3] — 2026-08-25

### Fixed

- **503 `server_error` outages now engage goal recovery** — regression fix:
  transient provider failures such as `Error: 503: {"type":"server_error",
  "message":"...Upstream request failed: Endpoint is unavailable."}` were not
  classified as network errors (the old matcher required the literal text
  "network error"), so the goal-level backoff never scheduled and active
  auto-continue goals stranded after Pi's built-in retries exhausted.
  Classification now covers HTTP 5xx-style outages (`server_error`,
  502/503/504/529, service unavailable, bad gateway, gateway timeout,
  upstream request failed, endpoint unavailable, overloaded); 4xx auth and
  malformed-request errors remain non-retryable.

### Changed

- **Unbounded-by-default recovery** — after Pi settles with a transient
  provider failure, an active auto-continue goal keeps retrying on the
  escalating backoff ladder (5–80s), plateauing at the maximum delay until
  the provider recovers, instead of giving up after five attempts. The cap
  and delays are configurable via layered settings:
  `networkRecovery.maxAttempts` (0/unset = unbounded) and
  `networkRecovery.maxDelayMs` (default 80000), or the
  `PI_GOAL_NETWORK_RECOVERY_MAX_ATTEMPTS` /
  `PI_GOAL_NETWORK_RECOVERY_MAX_DELAY_MS` environment overrides.
- Recovery notifications distinguish bounded progress (`recovery 2/5`) from
  unbounded (`recovery 2, unbounded`).

## [0.30.2] — 2026-08-24

### Added

- **pi.dev ranking badge** — README badge linking to `pi.dev/packages`,
  rendered as theme-aware SVG images (dark and light variants) so it displays
  correctly on GitHub in either color scheme. Meta text now reads
  "as of Aug 2026".

## [0.30.1] — 2026-08-24

### Added

- **Project logo** — added `pi-goal-x.png` as the README logo and as the
  package gallery image for `pi.dev/packages`.

## [0.30.0] — 2026-08-23

### Fixed

- **Network-error recovery for active goals (#36)** — after Pi exhausts its own
  provider retries with `network_error`, an active auto-continue goal now
  retries through a bounded 5/10/20/40/80-second backoff ladder. The fallback
  begins only after Pi settles, cancels cleanly on user interaction or goal
  lifecycle changes, and leaves the goal active with a clear warning after the
  capped recovery budget is exhausted.

## [0.29.0] — 2026-08-23

### Added

- **Complete model-context accounting (PR D)** — `npm run context:measure` /
  `context:gate`: composed-request measurement over 22 deterministic fixtures
  including active tool schemas; committed deterministic baseline.
- **Single-source active-goal prompt (PR E)** — current task rendered once,
  lifecycle rules stated once, concise `get_goal` default with optional
  verbose mode, `PI_GOAL_PROMPT_PROFILE=legacy-v1` emergency fallback.
  Composed requests reduced on every task fixture.
- **UI/model payload separation (PR F)** — audit events display-only;
  auditor progress derived from session events (progress tool removed);
  auditor prompt single-source; post-compaction delta.
- **Opt-in read-only blocker Oracle (PR G, #26)** — one stronger-model
  consultation per distinct blocker before blocking. Default off; explicit
  provider/model required; read-only session; follow-up gating; durable
  ledger events.

### Changed

- `update_goal({status:"blocked"})` now requires a `reason` describing the
  concrete blocker (feeds the blocker fingerprint and ledger record).
- Tool schemas grew by +136 bytes/request (`attempted_actions` parameter).

## [0.28.0] — 2026-08-23

### Added

- **Layered global settings (clean rewrite of #27)** — settings now resolve per
  leaf as `environment > project > global > defaults`. Global file:
  `~/.pi/agent/pi-goal-x-settings.json` (honors `PI_CODING_AGENT_DIR` and
  `PI_GOAL_GLOBAL_SETTINGS_FILE`); project file unchanged. Explicit `false`/`0`
  in a lower layer override inherited values; nested keybindings inherit per
  key; unknown keys are reported as diagnostics without erasing valid keys;
  writes are atomic and lock-protected against concurrent processes.
- **Scope-aware settings UI** — `/goal-settings` shows each row's effective
  value and source, can edit the project or global layer, and can remove an
  override to return to inheritance. Headless mode reports both paths.
- **`hideUnfocusedBanner` setting (clean rewrite of #29)** — optionally
  suppress the unfocused above-editor widget and status hint. Layered, with
  live hide/restore on toggle. Focused dashboards, audit UI, and the
  model-facing `[PI GOAL UNFOCUSED]` safety guidance are unchanged.
- **`npm run test:settings-race`** — two-writer concurrency coverage for the
  locked settings mutation path.

## [0.27.5] — 2026-08-23

### Fixed

- **Issue #30 — continuation checkpoints no longer persist the full goal prompt**
  Every auto-continue turn persisted a full continuation prompt (~6.4K chars:
  objective, task list, verification contract, lifecycle policy) as a custom
  session message; one reported session accumulated 851 byte-identical copies
  (~5.4 MB). Checkpoints are now bounded v2 trigger markers (≤160 chars) with
  structured metadata; the complete goal state is injected exactly once per
  turn via the system prompt, so nothing about model-facing behavior changes.
  Provider context retains at most one historical checkpoint marker; older
  markers are filtered out and legacy full checkpoints remain parseable.

### Added

- **Checkpoint health report** — `/goal-recovery` and `/goal-status health`
  now report persisted checkpoint counts, legacy/v2 classification, bytes
  spent on checkpoint content, and projected post-recovery size (read-only).
- **Offline session recovery CLI** — `pi-goal-x-recover` repairs existing
  oversized session files: dry-run default, `--apply` gated behind
  `--confirm-pi-closed`, timestamped backup, atomic rename, unchanged entry
  ids/parent links/line count/header, non-goal and malformed lines preserved
  byte-identically, idempotent. See README "Session checkpoint recovery".
- **B10 checkpoint-growth benchmark** gating persisted growth, provider-visible
  checkpoint count, recovery reduction, and composed-request duplication in
  `bench:gate:naf`.

## [0.27.4] — 2026-08-11

### Fixed

- **Agent writes no longer wipe the terminal scrollback when the widget +
  chrome overflow the terminal** — with the expanded widget plus the dock
  chrome (pending "Working…" line, status, editor, footer) taller than the
  terminal, pi's renderer treated every chat append and status/spinner tick
  as a change above its viewport top and full-rendered (`\x1b[2J\x1b[H\x1b[3J`),
  clearing the scrollback and forcing the viewport to the bottom every time
  the agent wrote. The widget now **sizes itself against the measured dock
  chrome**: it renders the sibling dock containers (pending + status + editor
  + footer) at the current width and caps itself at
  `terminalRows − (measuredChrome + 1)`, so the widget's block plus the
  chrome never exceeds the terminal — chat appends and status/spinner ticks
  become in-place diffs, never wipes, and scrolling up to read the chat
  holds while the agent works. The latch re-evaluates when the measured
  chrome changes (e.g. typing in the editor, the "Working…" status
  appearing); mock TUIs keep the static 6-row fallback.

Spec: specs/2026-08-11-stable-widget-height/

## [0.27.3] — 2026-08-11

### Fixed

- **Terminal stays scrollable while the expanded goal widget overflows it —
  no more jump-to-bottom on goal updates** — once the expanded widget was
  taller than the terminal, every goal-state change (usage tick, task
  completion, activity-feed growth, status change) altered the widget's
  rendered line count, which changed the buffer's line count, which made the
  terminal re-pin to the bottom — so scrolling up to read the agent's chat
  never held while the widget was active. The widget now keeps a **sticky
  cap**: the first render where its natural height reaches the terminal
  bound (`terminalRows − 6`) latches that exact height for the rest of the
  mode, rendering a deterministic head slice when content grows and blank
  rows when it shrinks, so the buffer line count never changes from
  goal-state updates. The cap adapts to the terminal (growing the window
  reveals more of the widget; when the widget fits, everything renders and
  terminal scrolling works), resets per mode (compact, expanded, audit,
  result card, debug, unfocused), stays optional for non-TUI callers
  (`/goal-status`), and emits no clear/scrollback-wipe sequences
  (`\x1b[2J`/`\x1b[3J`/1049).

Spec: specs/2026-08-11-stable-widget-height/

## [0.27.2] — 2026-08-10

### Fixed

- **Goal widget never fills the terminal — scroll-up works when the terminal
  is exactly the goal UI's height** — when the terminal window was just (or
  less than) the height of the goal UI, the widget rendered its full
  unbounded height: the goal UI consumed every row, the editor/chat fell out
  of the viewport, and every widget update triggered pi-tui's shrink
  full-render (`\x1b[2J\x1b[H\x1b[3J`), erasing terminal scrollback — so
  scrolling up had nothing to show. The widget now reads the terminal height
  at render time (`tui.terminal.rows`) and bounds its rendered lines to
  `terminalRows − 6` (reserving the status line, editor, footer, and a chat
  row) across every state (compact, expanded, audit, debug, result card,
  unfocused). The bound is a deterministic head slice: content that fits
  renders exactly as before, the widget never oscillates, and non-TUI
  callers (`/goal-status`) stay unbounded.

Spec: specs/2026-08-10-widget-height-bound-scrollback-fix/

## [0.27.1] — 2026-08-10

### Fixed

- **Questionnaire custom answers now accept typed input** — the shared
  questionnaire dialog (used by `goal_question`, `goal_questionnaire`, and
  the draft-confirm prompt) never anchored a text cursor: the dialog
  container was not `Focusable`, so the embedded editor emitted no
  `CURSOR_MARKER` and the hardware cursor stayed hidden for the whole dialog.
  Per pi's TUI contract this breaks IME/composed input (e.g. CJK candidate
  windows have no anchor) — reported as "the agent is not accepting my text
  input". The container now implements `Focusable` and propagates focus to
  the editor while typing; the hardware cursor is on during input mode and
  released on exit.
- **Every questionnaire option is immediately viewable** — the options list
  is no longer an internal scrollport that clips options behind
  arrow-key/Page scrolling at bounded terminal heights. All options (plus
  the "Write your own answer..." row) render in the initial frame; on
  overflow the question/context section yields first (it stays in the agent
  transcript). The scroll viewport remains only as a last resort when an
  option list alone exceeds the terminal height. The dialog never exceeds
  the terminal-height bound (churn guard preserved).

## [0.27.0] — 2026-08-09

### Added

- **`/goal-refresh`** — re-reads the pool, ledger (incl. checkpoint), and
  settings caches from disk and reports what changed; the explicit user-owned
  path for picking up external edits to `.pi` files (no watchers, no per-turn
  polling).
- **`/goal-recovery`** — read-only storage/recovery report: malformed goal
  files, malformed ledger lines, stale locks, and orphaned pool-snapshot
  entries. `/goal-recovery repair` removes stale locks and refreshes the pool
  snapshot after confirmation, with every touched file backed up to
  `.pi/goals/.recovery-backup/` first (malformed files/lines are reported
  only — never rewritten).
- **Versioned atomic ledger checkpoint** (`.pi/goals/.goal-ledger-
  checkpoint.json`) — startup loads the reconstructed state and replays only
  the ledger tail instead of parsing the whole JSONL; written atomically on
  the mutation path (throttled to hold the append headroom), with automatic
  full-parse fallback for missing/corrupt/version-mismatched checkpoints.
- **GitHub Actions CI** — Node 22 + 24 matrix runs `npm ci` → check → lint →
  test:all → selfcheck → pack dry-run → audit → NAF benchmark gate on every
  push and PR.
- **Engineering contract** — `package.json` declares Node `>=22.15.0` and pi
  SDK peer ranges `>=0.83.0 <0.85.0` (compat-tested on 0.83.0 and 0.84.1);
  Dependabot (weekly); a small ESLint gate; `noUncheckedIndexedAccess`
  enabled; superseded `docs/goal-ts-refactor-test-strategy.md` no longer
  shipped in the tarball.
- New benchmark rows for the checkpoint path and the pool-snapshot fast path
  (see BENCH-AFTER.md).

### Fixed

- **Pool-snapshot cold-start fast path** — the snapshot lived inside the
  goals directory whose mtime it uses as its freshness key, so its own write
  invalidated the key and every cold read paid an extra readdir fallback
  (3 ops instead of the claimed 2). Moved to `.pi/.goals-pool-snapshot.json`;
  `B1.pool.cold` is back to 2 ops; legacy in-dir snapshots are still read as
  a one-time fallback.
- **Test runner on Node 22** — `--test-isolation=none` (Node ≥ 23.4 only) is
  now probed and omitted on older releases, so the suite runs on the
  declared Node 22.15+ floor (verified 785/785 on Node 22.23).

## [0.26.3] — 2026-08-09

### Added

- `/goal-status health` provides a concise, read-only check of goal focus,
  lifecycle, active-file presence, malformed ledger entries, task progress,
  and token-budget pressure.

### Fixed

- Turn-buffered mutations now remain retryable when a per-goal lock is
  temporarily contended instead of being silently discarded.
- GoalService mutation paths share one batched ledger append and diagnostic
  implementation, reducing duplicated persistence logic and improving
  multi-event write performance.

## [0.26.2] — 2026-08-09

### Fixed

- **Goal questionnaire never hides options when height-bounded**: the
  terminal-height churn guard sliced options out of the `goal_questionnaire`
  dialog — the select-mode fit kept only the TOP options (option 2+ dropped
  entirely, e.g. a long question + 2 options at a 9-line bound), the
  context-heavy path could drop the first/recommended option, and there is no
  scrollback fallback (the tool-call line shows only the tool name), so a
  hidden option was a blind option. The dialog is now a `less`-style viewport
  over the full content: nothing is truncated, every option stays reachable
  via in-dialog scrolling (PageUp/PageDown page, Ctrl+↑/↓ line-scroll, ↑/↓
  selection auto-follows into view), a themed `▲ N more` /
  `… +N more · PgUp/PgDn scroll` edge indicator advertises clipped content
  (dashboard convention), the question and context are never ellipsized, and
  the churn-guard bound is preserved (the frame never exceeds the terminal
  height). Input mode keeps the editor prioritized; proposal confirmations
  keep their task + auditor segment protection unchanged.

## [0.26.1] — 2026-08-08

### Fixed

- **Proposal confirmation dialog restores the auditor toggle on bounded
  terminals**: the terminal-height churn guard sliced the interactive auditor
  status line ("●/○ Auditor enabled/disabled (press 'a' to toggle)") out of
  the confirmation frame, so the auditor on/off state could no longer be seen
  or changed at goal-propose time. `findProposalPresentationSegments` is now
  ANSI-aware (the plain-text task scan broke on styled lines and collapsed the
  tasks section to its header — rendering an empty `┌─ TASKS ─┐` box), keeps
  box-drawn task sections complete, and pulls the protected tail back to the
  auditor line so the toggle stays in frame within the height bound.
- **One task set per proposal**: the `propose_goal_draft` scrollback
  presentation now shows exactly the task set that will be persisted — a tweak
  without an explicit list shows the retained current list (previously a
  derived-from-objective phantom that was never applied), and the derived
  fallback for new drafts derives from the same objective text the apply path
  persists (Verification contract line stripped), so shown == persisted.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the `0.x` prefix indicating pre-1.0 development.

---

## [0.26.0] — 2026-08-07

### Fixed

- The goal-draft confirmation dialog no longer silently drops the
  "Tasks proposed for confirmation" section (or other contract sections)
  when the terminal is short. The bounded frame now keeps the dialog head,
  the tasks section, and the Confirm/Continue/Cancel options with footer
  within the height limit, sacrificing only the objective-box middle
  in-frame; the complete goal — every objective-contract section and every
  task line — is rendered into the scrollable terminal buffer the moment a
  proposal is made, so nothing is omitted and the user can scroll to re-read
  the full draft while deciding. The churn-guard invariant is preserved (the
  opened frame never exceeds the screen, so scrollback is never wiped),
  content that fits renders byte-identically, and no paging or new dialog
  chrome was added.
- Agent question dialogs no longer render unbounded on short terminals: the
  dialog height limit now falls back to reserving four rows for host chrome
  when the previous-frame height is unavailable (pi 0.84 fullscreen
  renderer), keeping questions readable.

### Changed

- Bumped `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and
  `@earendil-works/pi-tui` to 0.84.1.
- Goal auto-continuation now starts only after the agent fully settles
  (`agent_settled`) instead of at `agent_end`, avoiding polling a stale busy
  context for minutes on pi 0.84 while retries, compaction, and queued
  messages drain.

### Documentation

- Added spec docs for the question-readability fix and the goal-draft
  tasks-visibility fix (PRODUCT/TECH/MILESTONES under `specs/`).

---

### Changed

- The compact dashboard footer right-aligns a `Ctrl+Shift+A: toggle auditor`
  note beside the auditor dot (wide/medium layouts only) instead of
  appending the chord to the left hint — making explicit that the shortcut
  turns the focused goal's independent auditor on and off. Narrow/minimal
  layouts keep just the dot. Toggle behavior, keybinding, `auditor_toggled`
  ledger event, and inert guards are unchanged; the expanded dashboard
  stays byte-identical.

---

## [0.25.3] — 2026-08-07

### Changed

- Goal tweaks now auto-resume a stalled goal: confirming `/goal-tweak` on a
  paused or blocked goal transitions it to `active` (pause metadata cleared,
  `goal_resumed` ledger event with reason `tweak`, accounting and
  auto-continuation restarted). `budget_limited` remains a hard resource
  gate; an already-active goal is unchanged.
- Tweak drafting defaults the auditor toggle to the goal's persisted per-goal
  setting (`skipAuditor`) instead of the global `auditor disabled` setting,
  so the auditor on/off status survives a `/goal-tweak` unchanged (global
  settings remain the fallback when the goal has no per-goal value).
- The hard 4000-character objective limit is removed. Goal objective length
  is now governed by a new `objectiveMaxChars` setting (`0`/unset = no
  limit, the default), configurable via the settings menu or
  `PI_GOAL_OBJECTIVE_MAX_CHARS`, and enforced consistently across
  `create_goal`, `propose_goal_draft`, and `/goal-tweak`.

### Added

- The compact goal dashboard shows the focused goal's independent-auditor
  status as a minimal dot integrated into the bottom-right of the box
  border: green (`●`) when the auditor is on, gray when off. `Ctrl+Shift+A`
  toggles it per-goal from the UI — persisted to the goal file
  (revision-safe), with an `auditor_toggled` ledger event, a dashboard
  refresh, and a notification; wide/medium footers advertise the chord, and
  the toggle is inert when no goal is focused, a goal modal is open, or the
  goal is complete.

## [0.25.2] — 2026-08-07

### Changed

- Goal widget: the compact and expanded dashboard status lines now show
  `goal: <status> [<elapsed> <tokens>] (+N open)` (footer-status formatting:
  `running`, `paused (agent)`, `blocked`, … plus usage) instead of
  `Focused: yes / Other goals: N`; the usage moved from the header into the
  status line. The focused-goal footer line at the bottom of the pi screen is
  removed — the widget is the single home for goal status (the unfocused
  `goal: unfocused [N open]` hint is kept).
- Goal widget (compact dashboard): the `Tasks` section header now carries
  the top-level counts (`Tasks · ✓N done · M open`, skipped counted as
  done) plus a compact progress bar at the end of the row; the standalone
  `Tasks  [bar] X/Y · %` progress line is removed from the compact view
  (the expanded dashboard keeps its Progress section). Task rows with
  direct subtasks show a muted `▸ done/total` marker.
- Goal widget (compact dashboard): the current task's subtask progress bar
  moved **beside** the task progress bar in the `Tasks` header row
  (`· Sub done/total` + bar, shown only when the current task has
  subtasks; narrow mode drops the `Sub` word so the full counts fit at 50
  columns, minimal mode omits the segment) and the standalone compact
  `Subtasks  [bar] 2/3 · 67%` line was removed — the expanded dashboard's
  Current-task block keeps its subtask line.

## [0.25.1] — 2026-08-06

### Fixed

- Settings menu: positive-integer rows validate against a row-specific lower
  bound, so `stall timeout (minutes)` (default `0` = no stall timeout) can be
  set to `0` instead of being forced to min `1` like `subtaskDepth` (#19).
- Completion audit: the verdict marker (`<approved/>` / `<disapproved/>`) is
  accepted only as the final non-empty line of the auditor report; a prose
  mention of the marker elsewhere no longer counts as a verdict (#20).
- Completion audit: the objective, executor claim, goal details, verification
  contract, warm context, and task titles are escaped before interpolation, so
  payload text can no longer close a `<...>` section early and read as
  instructions (#21).
- `update_goal({status: "blocked"})` and `update_goal({status: "paused"})`
  now surface the mutation failure (e.g. revision conflict, goal modified by
  another process) instead of reporting success, and keep the turn alive so
  the agent can retry (#22).
- Escape on a live goal pauses it AND passes the key back to pi so the
  running tool execution / current turn is aborted — Escape stops the
  "working", it doesn't just flip the state. Escape while the goal is already
  paused passes through to pi to stop the current turn without any goal
  state change (restores the pre-runtime-overhaul behavior).

## [0.25.0] — 2026-08-06

### Changed (performance — non-agent flows ≥10x on most hot paths)

- Zero-op write-through session caches for settings, the goal pool, and the
  ledger: steady-state per-turn reads no longer touch disk at all (previously
  stat+read per call). Caches are invalidated by every extension write and
  reset at the session boundary, so all extension-mediated changes are always
  observed; the lock + revision check still guards cross-process writes.
- Ledger appends are direct O_APPEND writes with a per-directory mkdir memo
  (was temp-write→read→append→unlink per event; batched appends are one
  write). `appendGoalEvents` keeps the in-memory ledger cache current.
- Lock acquisition default window shrinks to ~10ms (was ~200ms): contended
  writes fail fast and the caller defers via the turn buffer instead of
  freezing the TUI.
- Ledger reconstruction uses generation-based focus tracking (O(1) per focus
  event instead of clearing every goal's flag — quadratic on focus-dense
  ledgers).
- Prompt task-list block compaction (formatting-only; pending task + contract
  on one line).
- Cold session start: the parsed active pool is persisted to
  `.pi/goals/.goals-pool-snapshot.json` and kept current by every extension
  write, so a fresh process loads the pool in ~3 fs ops instead of 2 per goal
  file (pool scan 102→3 ops, session startup 105→4 ops on this machine; the
  goals-dir mtime + filename-set check still forces a rescan on external
  add/remove). Settings cold load dropped its redundant stat (2→1 op).
- Bench harness: cold-start rows via fresh child processes
  (`b5b-cold-start.mjs`), before/after now 95 rows; four goal dialogs and
  tool-call headings remain byte-identical.

### Benchmarks

- Agent-free harness extended to the 0.24.0 unified-dashboard surface
  (15 new rows) and campaign-isolated before/after baselines
  (`experiments/bench/campaigns.mjs`; `npm run bench:naf`, `bench:gate:naf`,
  `classify.mjs`, `diff-bench.mjs`). Headline after numbers on this machine:
  pool scan @25ms/op 1.6s→0, settings load 33→0ms, per-turn reads 13→0 fs
  ops, startup 104→0 fs ops, lock contention 245→~17ms, ledger
  reconstruction 6.4→0.6ms @10k events, 4-event ledger append 20→1 fs op.

## [0.24.0] — 2026-08-06

### Added

- **Scrollable, latest-completion-anchored task list**: the task list in the
  dashboard is a window over the plan-ordered list that defaults to showing
  the most recently completed tasks (`completedAt` anchor) instead of the
  earliest ones, with `↑ N more` / `… +N more` indicator rows. The expanded
  dashboard is modal and scrolls with `↑/↓`, `PgUp/PgDn`, and `Home/End`;
  the compact widget never touches the editor's arrows and scrolls with the
  free `Ctrl+Shift+↑/↓` chords (consumed only when the list overflows, with a
  `Ctrl+Shift+↑↓: scroll` footer hint). A new completion re-anchors the
  window. `/goal-status` renders the same anchored window as a static
  snapshot; the window and indicators stay width-safe at 40–140 columns.
- **Unified goal dashboard** (see `docs/unified-dashboard.md`): one dashboard
  component in compact (above-editor) and expanded modes, driven by a shared
  pure presentation model (`extensions/widgets/goal-dashboard-model.ts`) used
  by the widget, `/goal-status`, and the completion flow.
- **Expanded dashboard**: the full task tree (✓ complete, ▸ current,
  ~ skipped, · pending), current-task block with verification contract and
  evidence, goal-level verification, and a recent-activity feed derived from
  the durable ledger. `Ctrl+Shift+T` toggles compact/expanded; `Esc`
  collapses.
- **Merged task overlay**: the separate task-list overlay registration is
  removed; its behavior moved into the dashboard's expanded mode.
- **Persisted current-task state**: optional `currentTaskId` on goal records
  (execution focus, distinct from completion status), `task_started` ledger
  event, `update_goal_task(status="start")`, normalization that accepts only
  existing pending tasks, and focus preservation/clearing on task-list
  restructuring. Legacy goal files load without the field and are never
  rewritten.
- **Improved `/goal-status`**: standard mode renders the same dashboard model
  (compact dashboard + current-task details + recent activity + last audit
  result, no settings noise); `/goal-status verbose` adds full diagnostic
  detail (id, revision, objective, tree with evidence and contracts, ledger
  history, budget, pause/blocker, paths, audit report, settings provenance).
- **Structured audit progress**: the audit widget shows five check stages
  (objective, verification, tasks, workspace, decision) with a progress bar
  and auditor identity; raw tools/output appear only in expanded/debug mode
  or on failure. Approval and changes-required result cards follow the audit.
- **Archive-result improvements**: successful archival emits `goal_archived`
  and reports the real archive path; failure never claims success, keeps the
  complete record recoverable, reports the remaining path, and writes a
  `goal_archive_failed` diagnostic ledger event.
- **Drafting polish**: durable proposal summary (objective, plan,
  verification, continuation, auditor state) in the transcript for every
  proposal outcome; richer confirmation output (goal id, file, task count,
  verification, auditor, budget); questionnaire answers are captured before
  draft state is cleared and appear in the created-goal report.
- **Width safety**: compact and expanded layouts adapt to wide/medium/narrow/
  very-narrow terminals; no rendered line ever exceeds the terminal width
  (asserted by golden tests at 40/50/60/80/100/140 columns).
- **End-to-end lifecycle test** (`tests/e2e/goal-lifecycle-dashboard.test.ts`)
  covering guided creation through archival (plan §19.9).
- **Compact tracker polish**: the compact dashboard now shows the top-level
  task list by default (colored markers, aligned id column, truncated titles,
  `… +N more` overflow), rounded box corners, `·`-separated status bits, and
  marker colors via the theme abstraction with a monochrome fallback —
  consistent across the widget, the expanded dashboard, and `/goal-status`.
- **Goal-draft proposals always show the task list exactly once**: the F2
  derived-task preview now derives from the raw objective (boxed confirmation
  text prefixed every line with `│`, hiding checklist/ordered markers); a
  `/goal-tweak` confirmation renders explicit tasks once inside its box and
  previews the retained current list when no tasks are proposed.
- **Goal-tweak status preservation**: a `/goal-tweak` that proposes a task
  list merges it into the existing tree by id (§7.5) — steps that persist
  keep their status, evidence, and timestamps; new steps start pending;
  removed steps drop; `currentTaskId` clears when its task is no longer
  pending. A tweak without a task list retains the current list unchanged.
- **Goal-settings menu fixes**: the settings menu renders its nine rows
  correctly (the `stall timeout (minutes)` row edits its own key, invalid
  `thinking_level` picks warn instead of failing silently).

### Changed

- **Dashboard palette (pastel)**: the outer box frame is drawn in the theme's
  light steel gray-blue (`mdLink`) — clearly lighter than the old dark
  `borderMuted` and in the same hue family as pi's own borders — while the
  interior rules stay in the theme's gray (`muted`) for hierarchy. Task rows
  are pastel amber (`mdHeading`) with colour-coded markers *and ids* (✓
  complete muted green, ▸ current teal, ~ skipped gray, · pending amber),
  and the current task is fully accent (marker, id, title). The header brand,
  progress fractions, and budget gauge are tinted; blocked/budget states use
  soft red/amber instead of neon yellow, and the header meta and footer
  hints are muted. Everything still follows the theme with a monochrome
  fallback.
- The task-overlay shortcut (`Ctrl+Shift+T`) now toggles the unified
  dashboard instead of opening a separate overlay.
- Prompt task blocks surface the persisted current task with its contract.
- The test runner discovers `tests/e2e/*.test.ts` (`npm run test:e2e`).

---

## [0.23.0] — 2026-08-05

### Added

- **Benchmark harness (PLAN.md Part 4, B1–B9)**: `experiments/bench/` —
  agent-free (B8: pi packages stubbed, `createAgentSession` throws,
  `node:fs` counted/latency-injected, net/http/https/child_process
  forbidden), with a before/after baseline table + per-feature budgets
  (`npm run bench -- before|after`, `npm run bench:gate`).
- **Feature-enhancement set (E1–E7)**: goal history (last audit + recent
  events) in `get_goal`/`/goal-status`; effective-settings provenance
  report and env-override read-only rows in `/goal-settings`;
  `auditorProjectResources` opt-in setting (off by default) so auditor
  sessions can load project skills/extensions; budget progress line in the
  goal widget + remaining-vs-overshoot in the budget-limited steering;
  questionnaire Q&A echo in the created-goal report; sisyphus "At step N of
  M" in `get_goal`; expandable pause/block reason detail in tool results
  (collapsed headings byte-identical).
- **Feature set (F1–F6)**: task detail block in the goal-running widget
  (counts, next pending with contracts, recent completion evidence) with a
  `get_goal` mirror; objective→task bootstrap at creation (confirmation
  dialog + `set_goal_tasks` guidance); interactive task toggling in the
  Ctrl+Shift+T overlay (Enter, same gates as `update_goal_task`, evidence
  dialog for contracted tasks); sisyphus Step N/M badge + current-step
  highlight in the widget; stall detector (`stallTimeoutMinutes` setting,
  `[GOAL STALLED]` steering note, widget badge); token-budget threshold
  alerts at 50/75/90% (`goal_budget_warning` ledger events + notifications).

### Changed

- **Optimisations (P1-1–P1-13)**: cache-first read layer (settings, goal
  files, pool listing — mtime/size keyed), incremental ledger tail (O(1)
  per-turn reads, torn-line safe), one-transaction-per-turn mutation buffer
  (one lock + one write + one ledger batch at turn end, flushed before audit
  dispatch/pause/focus-change/reload), trimmed task-list prompt block
  (pending-first, completed/skipped collapsed to counts; 2154→387 est tokens
  on a 50-task tree) with prompt fragment memoization, strictly bounded goal
  lock (~200ms fail-fast instead of ~2.8s frozen), warm-start auditor (ledger
  tail seeded into the audit prompt), parallel async session startup (~100x
  on slow storage at 50 goals), batched ledger appends, microtask-coalesced
  widget renders, single shared task-count walker, deduplicated dialog
  scaffold + contract/render helpers, goal-state widget glue extracted to
  `widgets/goal-widget.ts`, debug-only surface gated behind `PI_GOAL_DEBUG`.
- **New ledger event types**: `goal_budget_warning`, `goal_stalled`.
- **New settings**: `auditorProjectResources`, `stallTimeoutMinutes`.

### Fixed

- **Prompt-cache namespace race (P1-4).** `goalPrompt` and
  `continuationPrompt` share one memoization cache; before this fix the cache
  key did not distinguish the builder, so a continuation prompt cached via
  `queueContinuation`'s 0ms timer could be served back as the active goal
  prompt on the next turn (a `[GOAL CHECKPOINT]` frame where a
  `[PI GOAL ACTIVE]` frame belonged). The key is now namespaced per builder,
  with a regression test covering both call orders.
- `loadGoalSettings` silently dropped the new `auditorProjectResources` and
  `stallTimeoutMinutes` fields from its returned object — now carried
  through (E3's setting was previously inert).

---

## [0.22.0] — 2026-08-04

Single consolidated release on the simplification branch: the codex-inspired
interface, the hardening pass, the goal-runtime follow-up, the post-review
hardening round (provider-error continuation guard, modal Escape isolation,
additive usage merge, `/goal-settings` redesign), and the dialog/scrollback
stability fixes (bounded questionnaire render, spinner suppression) with their
committed before/after harness all ship together as the one version after the
0.21 baseline.

### Reverted

- **Goal dialogs and tool-call headings restored to the pre-regression
  surface (commit `383ae52`).** The previous unreleased round (alternate-screen
  dialogs, full wrapped headings, bounded bottom overlay panels) is fully
  reverted: `propose_goal_draft` / goal questionnaire opens inline in the main
  TUI buffer via plain `ctx.ui.custom` (chat history visible above, terminal
  scrollback fully usable — no DECSET 1049 alternate screen, no `\x1b[2J`
  clears); the task-list confirmation and audit escape dialogs return to their
  centered 70% overlays; `update_goal` headings render the status word only,
  and `set_goal_tasks` truncates the change summary to 80 columns again.
  Terminal scrollback is enabled in full: dialog content stays in the main
  buffer and is readable by scrolling up, and opening/navigating/closing cause
  no viewport churn for content that fits on screen. (A pre-existing pi-tui
  shrink path could clear the scrollback when closing a dialog taller than
  the terminal — now eliminated by the churn guard below; the fits-on-screen
  surface is unchanged.)

### Added

- **Codex-inspired five-tool model surface:** `create_goal` (objective
  1–4000 chars, mode, optional `token_budget`), `get_goal` (stable snapshot,
  no nudge map), and `update_goal` — terminal outcomes `complete` (audited
  from actual evidence; optional `completion_summary` is an untrusted
  claim), `blocked` (set only after the same blocker recurs on three
  consecutive goal turns), and `paused` (immediate agent pause with required
  `reason` and optional `suggested_action`) — plus the two consolidated task
  tools `set_goal_tasks` (flat parent-linked task-tree definition with
  confirmation) and `update_goal_task` (per-task
  `complete`/`skipped`/`pending` status updates without stopping the turn).
- **Token-budget support:** optional `token_budget` on creation; when
  accounted usage reaches the budget the goal transitions to a distinct
  `budget_limited` status exactly once, emits a `goal_budget_limited` ledger
  event, and injects one-time wrap-up steering (summarize, do not start new
  work, do not claim completion).
- **Curated fourteen-command palette:** `/goal` and `/sisyphus` start
  guided drafting (bare `/goal` is never status); `/goal-direct` and
  `/sisyphus-direct` bypass it; `/goal-list`, `/goal-focus`, `/goal-unfocus`,
  `/goal-settings`, `/goal-tweak`, `/goal-clear`, `/goal-pause`,
  `/goal-resume`, plus `/goal-status` (read-only focused-goal summary) and
  `/goal-cancel` (discard the in-progress draft as a durable no-op).
- **Guided drafting runtime, restored as a first-class workflow.** Drafting
  runs in a transient, user-invoked profile with `goal_question`,
  `goal_questionnaire`, and `propose_goal_draft` (Confirm / Continue /
  Cancel with per-draft auditor selection); confirmation atomically creates
  the objective, verification contract, and task tree, then restores the
  execution profile. Drafts persist in branch-local `pi-goal-draft` session
  entries (survive compaction and tree navigation) with Resume/Replace/Cancel
  protection; Sisyphus proposals require ordered-step structure;
  contracts-disabled settings keep contract lines as plain prose.
- **GoalService/runtime/accounting extraction:** `goal.ts` is a thin
  installer; state lives in a shared `GoalCore` (goal-state.ts) with
  tools/commands/events/widget/format split into dedicated modules.
- **Cross-process mutation serialization:** goals carry a persisted
  monotonic `revision` (legacy records normalize to zero); `GoalService`
  acquires a per-goal filesystem lock, re-reads the authoritative file under
  it, and returns typed conflicts to stale writers instead of overwriting
  blindly. `update_goal_task` retries once only when the same task and
  status/structure remain unchanged; `set_goal_tasks` surfaces the typed
  conflict.
- **Enforced, portable experiment harness:** `SUPPORTED_CASES.json`
  membership is required before a run directory is created (raw dirs need
  `--allow-unsupported`); the provider smoke uses the selected model and
  validates HTTP status and JSON shape with capped response text; the outer
  timeout discovers `timeout`, `gtimeout`, then a bundled Node watchdog;
  shell tests with stubbed curl/pi cover resolution, payload, missing
  configuration, and timeout selection; an observations index marks old runs
  as historical evidence. Experiment cases B1–B2 and C1–C26 are migrated to
  the current interface with mechanical rubrics.
- **Test runner self-check:** `npm run test:selfcheck` asserts the
  discovered test entries match the pinned manifest.

### Changed

- **Settings menu is fully operable.** Every persisted field is selectable
  and editable through `/goal-settings` (`disableTasks`, `disableContracts`,
  `autoSelectSingleGoal`, `disabled`, `provider`, `model`, `thinkingLevel`,
  `subtaskDepth`); `subtaskDepth` validates the full input string (whole
  positive safe integers only) and repeated task toggles in one menu session
  reinstall the correct fixed three/five profile every time.
- **`/goal-clear` asks for confirmation.** Cancelling changes no file,
  focus entry, ledger entry, or runtime state (byte-for-byte no-op); headless
  runs return guidance without mutation. The focus is re-validated after the
  dialog so a stale confirmation never archives the wrong goal.
- **Task-list confirmation uses neutral labels.** The dialog offers Confirm
  task list / Keep current tasks and returns only a task decision — no
  goal-creation wording, questionnaire state, or auditor toggle.
- **Completion commits are failure-checked.** `commitGoalCompletion` returns
  a discriminated result and inspects `GoalService.apply`; a failed state
  mutation never renders a success report, a `goal_completed` event, or a
  focus clear, and deferred-archive failures surface as observable warnings.
- **Audit aborts produce one canonical outcome.** Escape during an audit
  records transient state only; the eventual user choice writes exactly one
  ledger event — `audit_skipped(user_aborted)` for complete-without-audit,
  nothing for continue-working — and continue-working leaves the goal active.
- **`/goal-tweak` is a guided, user-confirmed refinement** through
  GoalService (preserves usage/tasks/mode/budget, reactivates
  `budget_limited` goals), validated against the focused goal's revision and
  staying user-started — there is no steady-state `propose_goal_tweak`.
- **Capability parity without tool sprawl.** The agent can pause with a
  reason and optional suggested action; abandonment stays user-owned via
  `/goal-clear`; objective changes stay user-started via `/goal-tweak`;
  `completion_summary` is passed to the auditor as an untrusted claim —
  never evidence, never an approval bypass.
- **Bounded five-tool steering prompts** (10k fragment cap, objective
  escaping, three-turn blocker policy).
- **Pi SDK family upgraded to 0.83** (`pi-ai`, `pi-coding-agent`, `pi-tui`
  together; no forced audit-fix split). Both the full development graph and
  the published/runtime graph audit clean (transitive advisories fixed with
  same-major overrides; the lock was generated with npm 12 because npm 11
  ignores overrides and `npm ci` replays the resolved versions).
- **Test runner consolidation.** Unit and handler-integration tests are
  automatically discovered and run in one Node process with
  contract-faithful test adapters for the small Pi SDK runtime surface they
  exercise; `test:serial` remains the real-SDK, process-isolated
  compatibility path. `tests/e2e/extension.test.ts` is replaced by
  `tests/integration/extension.test.ts` (the handler-level integration suite
  drives the actual registered tools with an auditor fixture).

### Fixed

- **Provider-error turns no longer auto-continue.** A turn/run whose
  assistant message has `stopReason: "error"` (provider failure or empty
  terminal response) no longer queues a goal auto-continuation — previously
  a single failed hidden checkpoint could become an unbounded
  checkpoint/error retry storm. Accounting and display reconciliation still
  run; only the continuation queue is suppressed (`goal-events.ts`, danim47c
  pattern).
- **Escape is owned by the active goal dialog.** While any goal-owned modal
  is open (questionnaire, task-list confirmation, goal settings, goal
  picker/focus, task-list overlay, audit escape dialog), Escape closes the
  dialog and never pauses the goal — the global Escape-to-pause handler
  yields via a modal depth counter (`enterGoalModal`/`exitGoalModal` in
  `try/finally`, bn-l pattern). Previously only the audit escape dialog was
  guarded, so Escape in a proposal or settings dialog could pause the running
  goal before the dialog processed it.
- **Usage/accounting no longer lost on revision conflicts.** `persist()` on
  a revision conflict (another process wrote the goal) now merges the local
  session's additive token/time delta onto the disk record and advances its
  revision, instead of silently dropping the update. The disk's authoritative
  fields (objective, tasks, status) are preserved; usage stays monotonic and
  is never double-counted.
- **`/goal-settings` redesign.** The settings menu is sectioned (Goal
  behavior / Task tracking / Completion auditor); the auditor provider/model
  rows open a searchable model picker (current-session/default entry,
  authenticated models with a ✓ marker on the exact current selection, and
  an advanced manual `provider/model` entry); thinking level is a selector;
  the auditor enable/disable row reads "auditor disabled". Provider-only
  auditor configuration is now refused with a clear error instead of
  silently picking the first available model (ll01 pattern).
- **Goal questionnaire viewport churn (taller-than-screen proposals).**
  Closing a questionnaire whose opened frame exceeded the terminal height
  triggered pi-tui's generic shrink full-render
  (`\x1b[2J\x1b[H\x1b[3J`), erasing terminal scrollback and leaving the
  viewport at the top, so the window took ~10s to scroll back to the bottom.
  `runGoalQuestionnaire` now bounds its render to the terminal height with a
  tail slice (`max(10, rows − pre-dialog frame + 1)`; only engaged with real
  TUI dimensions): the opened frame never exceeds the screen, so there is no
  shrink full-render — no 2J/3J, no viewport jump — while content that fits
  renders exactly as before (383ae52). Tradeoff for taller-than-screen
  dialogs: the tail (options/footer + last content) stays in view; the
  dialog head is not written to the buffer.
- **Terminal scrolling back down while reading a goal dialog.** With the
  dialog open and the user scrolled up to read the proposal, the viewport
  snapped back to the bottom “after X seconds”: pi's working spinner ticks
  every ~80ms and each tick rewrites its line (~44 bytes), and any output
  while scrolled up snaps the viewport to the bottom in iTerm2/Ghostty/kitty
  (default behavior). The goal dialogs (questionnaire, task-list
  confirmation, escape dialog) now pause the spinner for their duration
  (`setWorkingVisible(false)` on open, `setWorkingVisible(true)` on
  close/dispose) — measured 0 bytes per tick afterwards, so reading the
  proposal in scrollback is undisturbed. No-op in headless contexts.
- **Programmatic before/after test:**
  `experiments/scroll-repro/before-after-churn.mjs` drives the real
  `runGoalQuestionnaire` through the real pi-tui renderer with the real pi
  frame layout (header, chat, status-with-spinner, editor, footer) and
  reports open/nav/close scrolls, 2J/3J emissions, post-close viewport
  position, scrollback content, and the bytes emitted by five working-spinner
  ticks while the user is scrolled up reading the dialog; `--expect-fixed`
  asserts the fixed behavior (exit 0: no 2J/3J anywhere, no periodic output,
  fits scenario stays 0-churn).

- **Persisted lifecycle status is authoritative.** The paused `&&`
  autoContinue `=>` active migration is deleted: a persisted paused record
  (including the legacy `{status:"paused", autoContinue:true}` case) stays
  paused through every read, markdown parse, and session restore.
  `autoContinue` is an execution preference and never rewrites status.
- **Disabled-auditor completion is reachable.** `settings.disabled: true` is
  an explicit user-owned setting that skips the auditor, records
  `audit_skipped`, and completes through the normal deferred-completion path
  — no model-only bypass field. All successful completion commits
  (audit-approved, globally disabled, legacy per-goal skip, Escape bypass)
  share one transaction helper.
- **Disk-fresh task transactions.** `update_goal_task` reconciles the
  focused record, validates the focus token, loads the task from the
  disk-refreshed clone, validates the transition against it, and updates only
  that task's path, returning typed failures for
  removed-task/task-list races. Concurrent external task edits survive unless
  the operation changes the same task.
- **Structural task replacement clears omitted fields.** Matching task ids
  preserve only runtime progress (status, evidence, completion/skip
  timestamps, skip reason); omitted structural fields (verification contract,
  lightweight flag, children, parentage) are cleared, not inherited.
- **Token budget hardening.** `token_budget` is a positive safe integer in
  the schema and at runtime; fractional, zero, negative, infinite, and unsafe
  values are rejected live and normalized to absent when persisted.
- **Ledger vocabulary and diagnostics.** Reopening a task writes
  `task_reopened` (the old synthetic `task_skipped` unskip reason still reads
  back); `appendGoalEvent` returns a discriminated result and every
  GoalService ledger loop routes failures through an observable
  `onDiagnostic` hook without rolling back the authoritative state write.
- **Fixed three/five tool profile.** `installGoalToolProfile` installs
  exactly five goal tools with tasks enabled, exactly three when disabled,
  only at session start and on `disableTasks` settings toggles; lifecycle
  transitions never add/remove/restore goal tools and ordinary pi work tools
  are never touched.

### Removed

- **Hidden tool shims and legacy command routing:** the `complete_goal`,
  `pause_goal`, `abort_goal`, `propose_goal_tweak`, `propose_task_list`,
  `complete_task`, `skip_task`, and `step_complete` tool registrations are
  gone from the active surface; the `/goals`, `/goals-set`, `/sisyphus-set`,
  and `/goal-abort` command registrations are gone. The drafting tools
  (`goal_question`, `goal_questionnaire`, `propose_goal_draft`) live only
  inside the transient drafting profile, and the restored `/goal-status` is a
  read-only command. Old goal-file and ledger readers
  (`readActiveGoalPool`, `readGoalLedger`, `mergeGoalPromptFromDisk`,
  `latestAuditorResultForGoal`, `normalizeGoalRecord`) remain for
  backward-compatible reads of existing data. See the README “Command
  migration” and “Tool migration” tables.
- Obsolete abort/pause/completion-summary policy builders.

---

## [0.21.0] — 2026-08-03

### Added

- **`/goal-unfocus` command:** Detaches the current session from its focused goal,
  stops or aborts that session's continuation and in-flight goal work, and records a
  session-local null focus entry with reason `unfocused` without pausing, modifying,
  archiving, or writing a focus event for the shared goal in `.pi/goals/`. Pending
  audits and confirmation flows revalidate session focus before applying results.

### Documentation

- Clarified that `autoSelectSingleGoal: false` keeps focus—not the shared project goal
  files—session-scoped.

## [0.20.1] — 2026-08-03

### Fixed

- **Republished to match merged main:** The 0.20.0 npm tarball was built from the
  integration branch before the merge and omitted the local main line changes
  (`propose_goal_tweak` tasks parameter with inheritance and box-drawn display,
  `renderConfirmationTasks` refactor, deferred `syncGoalTools`, test/CHANGELOG updates).
  0.20.1 ships the full merged tree at `origin/main` (merge commit 3274063), including
  all five integrated PRs (#4-#8).

## [0.20.0] — 2026-08-03

### Added

- **`autoSelectSingleGoal` setting (opt-in single-open auto-focus):** Sessions now start
  unfocused by default so goals stay session-scoped when multiple sessions share the same
  `.pi/goals/` directory (e.g. an Obsidian vault). Set `autoSelectSingleGoal: true` in
  `.pi/pi-goal-x-settings.json` (or via `/goal-settings`) to restore the previous behavior
  where a single open goal is auto-focused when no focus entry exists. (PR #4)

### Fixed

- **Terminal scrollback preserved while goals are active:** Removed the private 1-second
  status-refresh timer that forced TUI redraws (`ui.setStatus` + widget update), which
  pulled users out of terminal scrollback while reviewing long goals. The widget still
  catches up on natural renders. (PR #5)

- **Completion auditor lost Cursor / extension-provider auth on pi 0.81+:** Nested
  `createAgentSession` for the independent auditor still passed `modelRegistry`, but pi
  0.81+ only accepts `modelRuntime`. Combined with the auditor's empty resource loader
  (no `pi-cursor-sdk`), that built a fresh runtime without the registered `cursor` provider
  and failed with `No API key found for cursor` even when `auth.json` had a Cursor API key.
  The auditor now reuses the parent session's ModelRuntime (via `modelRegistry.runtime`)
  while still passing `modelRegistry` for older SDKs. (PR #6)

- **Goal state no longer appended to the session on every persistence event:** Full goal
  snapshots were duplicated into the session JSONL on every update, which could bloat a
  multi-day session to hundreds of MB and exhaust the heap. Goal files under `.pi/goals/`
  remain authoritative; legacy snapshot reads are kept for migration. (PR #7)

- **`syncGoalTools()` deferred out of top-level extension load:** It now runs in
  `session_start`, eliminating the spurious "Extension runtime not initialized. Action
  methods cannot be called during extension loading" error logged on every session start.
  No behavior change — `before_agent_start` already re-syncs before every real turn. (PR #8)

## [0.19.0] — 2026-06-14

### Added

- **propose_goal_tweak: tasks parameter, inheritance, and box-drawn task display:**
  `propose_goal_tweak` now accepts an optional `tasks` parameter (same schema as
  `propose_goal_draft`). When omitted, the current goal's task list is inherited
  automatically. The confirmation dialog displays the task list in a box-drawn
  format (`┌─ TASKS ──┐`) matching `propose_goal_draft`. The drafting prompt
  surfaces the current task list and instructs the agent to edit inherited content
  directly rather than rewriting from scratch. Task validation (subtask depth)
  is applied. Tasks are persisted on the goal record when confirmed. (6 tests,
  390 total pass.)

### Refactored

- **DRY shared confirmation rendering:** Extracted `formatModeLabel`,
  `formatPrefixedLines`, `formatSection`, and `renderConfirmationTasks` helpers
  from the duplicated inline rendering in `buildDraftConfirmationText` and
  `buildTweakConfirmationText`. `goal.ts` now imports `renderConfirmationTasks`
  from `goal-draft.ts` instead of defining its own local copy. `buildDraftConfirmationText`
  shrank 44% (16→9 lines), `buildTweakConfirmationText` shrank 70% (56→17 lines).

## [0.18.10] — 2026-06-12

### Fixed

- **syncGoalTools deferred from top-level to session_start:** Removed the top-level
  `syncGoalTools()` call that fired during extension loading, before the runtime was
  initialized. This was the cause of the "Extension runtime not initialized. Action
  methods cannot be called during extension loading" error. `syncGoalTools()` is now
  called inside the `session_start` handler, after `loadState()`. Added an e2e test
  that verifies no `getActiveTools()` calls occur during extension registration and
  that the call only fires after `session_start`.

## [0.18.9] — 2026-06-10

### Fixed

- **turnSeq scoping for turnStoppedFor:** Added a per-turn generation counter so stale
  turn-stop markers from prior turns or session resumes cannot accidentally block an
  active goal's tool calls. A new `advanceTurnSeq()` function increments the counter at
  the start of each turn; `currentTurnStoppedGoalId()` returns the stopped goal only if
  its sequence matches the current turn.

- **Stale continuation checkpoint guards:** Added `checkpointGoalId` tracking and
  `isActionableContinuationGoal()` to prevent work tools from executing when a queued
  continuation fires for a goal that has been paused, cleared, or replaced. The
  `before_agent_start` handler now reconciles from disk and aborts the turn for stale
  checkpoints. The `tool_call` handler also blocks work tools mid-turn when a stale
  checkpoint is detected.

  These changes incorporate selected improvements from PR #1 by codewithkenzo.

## [0.18.8] — 2026-06-10

### Changed

- **README restructured for user-facing clarity:** Merged "What's different from upstream" and
  "What it provides" into a single 13-item headline Features section placed at the top of the
  document. The fork context is condensed to a one-paragraph note below Features. Stale
  `update_goal` references replaced with `complete_goal`. The rest of the document (Install,
  Quick start, Commands, etc.) is preserved unchanged.

## [0.18.7] — 2026-06-07

### Fixed

- **Lifecycle tools now reliably visible for active goals with task lists:** Two root
  causes were identified and fixed:

  1. **`turn_start` did not sync tools** — The `turn_start` handler reset per-turn flags
     but never called `syncGoalTools()`. Tools were only synced later in
     `before_agent_start`, creating a gap where the system prompt could be built with
     stale tools. Added `syncGoalTools()` to `turn_start`.

  2. **Non-progress research tools blocked lifecycle tools** — The `tool_call` handler
     set `turnStoppedFor` for any non-progress tool call (e.g., `web_search`,
     `code_search`, `fetch_content`). This blocked ALL subsequent tool calls including
     `complete_task` and `complete_goal`. The `goalWorkToolCalledThisTurn` flag already
     prevents infinite continuation chains; `turnStoppedFor` is only needed for
     post-stop commands (pause/abort/complete). Removed the problematic `else` branch.

### Added

- **4 new tests for lifecycle tool reliability:**
  - `active goal with task list exposes all lifecycle tools`
  - `active goal with task list shows correct tools across multiple turns`
  - `complete_task tool executes and stays active after marking tasks done`
  - `turn_start re-syncs active tools after external removal`

## [0.18.6] — 2026-06-05

### Fixed

- **Esc → "keep working on goal" now pauses the goal:** When the user presses Escape
  during a completion audit and selects "continue working," the goal is paused
  (status → "paused") instead of staying active. The agent stops and waits for the
  user to manually resume via `/goal-resume`, preventing confusing auto-continuation.
  `turnStoppedFor` is also set to block subsequent tool calls in the same turn.

- **Noisy audit-escape notifications removed:** The `ctx.ui.notify("Audit skipped by
  user.", "warning")` call in `abortAudit()` is removed. The "continue working"
  branch no longer sends a `pi.sendMessage()` with audit-skipped content or returns
  "Resume working toward the goal." — it returns a clean "Goal paused" message
  instead.

### Added

- **Tests for escape dialog wiring:** 3 new tests verify `complete_goal` has the
  `confirmBypassAuditor` parameter, the `tool_call` handler is registered, and the
  escape dialog handler paths are wired.

## [0.18.5] — 2026-06-02

### Fixed

- **`syncGoalTools` error during extension loading:** Removed `syncGoalTools()` call from
  `loadState()` (called by `session_start` and `session_tree` handlers) to prevent
  "Extension runtime not initialized" error when the runtime hasn't finished binding yet.
  The first tool sync now happens in `before_agent_start`, which fires after the runtime
  is fully initialized.

### Changed

- **Tests updated for new lifecycle flow:** Four tests in `goal-tool-visibility.test.ts`
  updated to invoke `before_agent_start` after `session_start`, matching the new lifecycle
  ordering where `session_start` loads state but does not sync tools.

## [0.18.4] — 2026-05-31

### Added

- **Task list overlay (`Ctrl+Shift+T`)** — a scrollable modal overlay showing all tasks for open goals, triggered by `Ctrl+Shift+T`. Includes status icons (✓ complete, ◌ pending, — skipped), tree branch lines for subtasks, scroll indicators (▴/▾), keyboard navigation (↑↓/jk/PgUp/PgDn/Home/End), and Esc/Enter to dismiss. All styling uses TUI theme colors. (`extensions/widgets/task-list-overlay.ts`)

- **Default to current goal, 'a' toggle** — the overlay now defaults to showing only the focused goal's tasks. Pressing `a` toggles between "current goal" and "all open goals" views. Footer shows context-sensitive hint ("show all" / "show current"). Scroll position resets on toggle. (`extensions/widgets/task-list-overlay.ts`)

- **Text wrapping for long titles** — `wrapTextWithAnsi` replaced truncation in the overlay. Task titles and goal headers wrap at word boundaries with continuation-line indentation. Goal status labels overflow to their own dim line when the title is long. (`extensions/widgets/task-list-overlay.ts`)

- **Lifecycle tool visibility tests** — comprehensive test suite in `tests/goal-tool-names.test.ts` (94 new tests) covering all status × phase combinations for goal lifecycle tools (pause, complete, abort, propose_goal_tweak, propose_task_list, complete_task, skip_task). `tests/goal-tool-visibility.test.ts` (391 new tests) covers lifecycle event-driven tool visibility.

### Fixed

- **`syncGoalTools` bare `try-catch`** — the catch block in `syncGoalTools` was silently swallowing errors from `getActiveTools()` and subsequent `addTool`/`removeTool` calls. Replaced with a logging catch and added a defensive `Array.isArray` guard on the `getActiveTools()` return value so type mismatches (e.g., `Map` instead of `string[]`) don't corrupt tool state.

- **e2e mock tool tracking** — `getActiveTools()` in the e2e mock was returning a `Map` instead of `string[]`, and `setActiveTools` was a no-op, preventing `syncGoalTools` from properly tracking lifecycle tool visibility. Fixed to return `string[]` and update internal state.

## [0.18.3] — 2026-05-30

### Fixed

- **`addWrappedPipe` overflow in questionnaire** — `addWrappedPipe` in `goal-questionnaire.ts` was wrapping content at the full terminal width then prepending `│   ` (4 visible chars) to continuation lines, causing a terminal-width overflow crash (visibleWidth > safeWidth). Fixed by wrapping at `safeWidth - pipeWidth` so continuation lines with the pipe prefix stay within bounds.

- **Escape dialog header overflow** — the header text `"Audit interrupted by Escape  (continue = default)"` (53 visible chars) was not truncated to `innerWidth` at narrow terminal widths, causing overflow. Fixed by adding `truncateToWidth()` to the header line.

### Added

- **Overflow regression tests** (`tests/overflow-regression.test.ts`) — 20 new tests covering the `addWrappedPipe` fix at every width 20-120, with styled ANSI content, CJK wide characters, mixed content, single long words, exact wrap boundaries, whitespace handling, minimum width, and the exact crash scenario reproduction. Also covers `truncateToWidth` safety net at every width 1-120, with ANSI codes, and CJK chars.

- **Escape dialog overflow regression tests** (`tests/goal-escape-dialog.test.ts`) — parameterized tests at widths 50/60/70/80/90/109 asserting no rendered line exceeds the terminal width.

- **Widget overflow regression tests** (`tests/goal-widget.test.ts`) — parameterized widget safety net tests at widths 50/70/100/109/120, auditor progress crash regression, and unfocused widget with 38 open goals at width 109.

## [0.18.2] — 2026-05-29

### Changed

- **Co-proposal prompt guidance** — the drafting protocol in `goal-draft.ts` and the continuation prompt in `goal-prompts.ts` now instruct agents to include the task list in the `tasks` parameter of `propose_goal_draft` when the objective decomposes into milestones. The old guidance encouraging `propose_task_list` after goal confirmation has been removed.

## [0.18.1] — 2026-05-29

### Fixed

- **TUI crash guard** — pi-tui differential render no longer throws a fatal error when a line's visible width exceeds terminal width. Both the incremental render path and the full-redraw path now truncate overflowing lines with `truncateToWidth()` instead of crashing.
- **Widget safety net** — `GoalWidgetComponent.render()` post-processes every line and truncates any that exceeds the render width, defending against widget edge cases that could bypass per-line truncation.

### Added

- **Regression test** — `goal-widget.test.ts`: "GoalWidgetComponent safety net truncates any line exceeding width" asserts that rendering at width 50 with extreme-length content produces no line with `visibleWidth > 50`.

## [0.18.0] — 2026-05-29

### Added

- **Hidden TUI debug mode** — Ctrl+Shift+X toggles a debug panel in the goal widget with raw goal field display, task tree summary, and legend. Ctrl+Shift+N creates/removes a test goal (writes to `.pi/goals/debug/`), Ctrl+Shift+T injects sample tasks, Ctrl+Shift+R starts a mock completion audit, and Ctrl+Shift+O opens the proposal confirmation dialog with a realistic proposal built from typed `GoalTask[]` objects through the real rendering pipeline.
- **`addWrappedPipe` helper** — pipe-prefixed (`│   `) lines that wrap now prepend `│   ` to every continuation line so wrapped text stays inside the ASCII box.
- **Task checkbox detection inside pipe sections** — `│   [x] t1: ...` lines are now properly detected as task checkboxes (not misinterpreted as key-value pairs) and render with per-status coloring inside the box.

### Changed

- **MAX_CONTEXT_LINES removal** — the 12-line truncation cap (`MAX_CONTEXT_LINES = 12`) is removed from `goal-questionnaire.ts`. The full proposal is now visible without truncation. Replaced `addContextWrapped` with `renderContextLines` that renders every line with per-line styling.
- **Enriched confirmation dialog** — `buildDraftConfirmationText` and `buildTweakConfirmationText` now emit `─── Section Name ───` markers that `renderContextLines` converts to full-width box-drawing borders (`┌─ Section Name padding─┐`). Task checkbox items get per-status coloring (`[x]` success green, `[ ]` warning yellow) with item titles in muted. Goal structure lines (`=== Goal ===`, `Objective:`, `Success criteria:`, `Boundaries:`, `Constraints:`, `Verification contract:`, `If blocked:`) are detected and styled as accent.
- **Pipe prefix for all objective content** — `buildDraftConfirmationText` and `buildTweakConfirmationText` now prefix every objective line with `│   ` (except lines already starting with `│`). Task checkbox lines and box-drawing borders inside the objective text now appear inside the ASCII box with consistent indentation.
- **Debug proposal task lines** — `renderDebugTaskLines` output in the debug Ctrl+Shift+O dialog is now prefixed with `│   ` to match the box layout.

## [0.17.0] — 2026-05-29

### Added

- **`auditorEnabled` in questionnaire results** — `runGoalQuestionnaire` accepts an optional `auditorToggleInit` parameter and returns `auditorEnabled` in the result object. The confirmation dialog shows an "Auditor enabled/disabled" toggle indicator.
- **Per-goal `skipAuditor` field** — users can toggle the auditor off or on during goal confirmation. The choice is persisted on the goal record as `skipAuditor: true/false`. `complete_goal` skips the audit when `skipAuditor` is true on the target goal.
- **`isAuditorEnabledByDefault`** — new helper in `goal-settings.ts` that returns `true` unless `disabled: true` in the settings file or the `PI_GOAL_SETTINGS_FILE` env var.
- **Recursive duplicate task ID detection** — `checkDuplicateTaskIds` recursively validates all task IDs across the entire tree, preventing collisions between parent/subtask or sibling subtasks. Added to `validateTaskListProposal`.

### Changed

- **Task section appears first in draft context** — when both a goal objective and task list are proposed together, the task summary section appears FIRST in the context so it stays visible even when dialog context was previously capped.
- **`findTaskInTree` for task operations** — `validateTaskCompletion` and `validateTaskSkip` now use `findTaskInTree` instead of flat array lookup, enabling subtask tree operations.
- **Allow re-skipping already-skipped tasks** — `validateTaskSkip` no longer rejects already-skipped tasks, enabling toggle behavior.
- **Prompt wording cleanup** — `complete_goal` prompt guidance trimmed to remove redundant phrasing.
- **`complete_goal` status default** — `status=complete` is now the default when `status` parameter is omitted.
- **Audit flow with per-goal toggle** — when `skipAuditor` is true on a goal, the audit is skipped during `complete_goal` and a ledger event `audit_skipped` is appended.

### Fixed

- **Dialog failure fallback** — `showProposalDialog` catches errors in interactive mode and notifies the user; creation fails closed and never auto-creates a goal on dialog failure.

## [0.16.1] — 2026-05-28

### Added

- **Escape-to-skip audit** — pressing Escape during an auditor run now aborts it and completes the goal immediately. The skip is recorded in the ledger with the reason `user_aborted` and auditor model metadata.
- **Audit progress widget** — the TUI shows a spinner, progress bar, step labels, current tool, and output lines while the auditor runs.
- **Audit abort detection** — the auditor detects aborts from both exceptions and `session.prompt()` returning after an abort signal, preventing stuck goals or ghost states.
- **COMPLETED status for Sisyphus** — completed Sisyphus goals now show a `COMPLETED` status label instead of a generic complete indicator.
- **Multi-session focus isolation** — goal focus data uses `goalFocusDetails` which includes the goal id and reason but not full balance data, preventing cross-session focus leakage.

### Fixed

- Fixed a merge bug where `propose_task_list` could produce a duplicate task list when called during a continuation.

## [0.16.0] — 2026-05-28

### Added

- **TUI Escape dialog during audit** — pressing Escape during a completion audit now shows a TUI confirmation dialog with two options: "Mark complete without audit" (bypasses auditor, marks goal complete immediately, agent receives structured message) and "Continue working" (skips audit, agent resumes). Replaces the old agent-mediated "Use goal_question" pattern.
- **`showEscapeDialog()` widget** — new `extensions/widgets/goal-escape-dialog.ts` with headless fallback.

### Changed

- **Goal prompt updated** — no longer instructs the agent to handle Escape via goal_question; describes the automatic TUI dialog instead.

## [0.15.1] — 2026-05-28

### Fixed

- **Error messages referencing old file** — four user-facing messages in goal.ts no longer mention `.pi/goal-settings.json` (now say "settings").
- **README stale reference** — feature bullet now points at `.pi/pi-goal-x-settings.json`.
- **Cleaned up orphaned file** — removed stale `.pi/goal-auditor.json` from disk.

## [0.15.0] — 2026-05-28

### Changed

- **Unified settings file** — all settings now live in a single `.pi/pi-goal-x-settings.json` file instead of two separate files. The unified file includes `disableTasks`, `disableContracts`, `subtaskDepth`, `provider`, `model`, `thinkingLevel`, and `disabled`. Clean break: old `.pi/goal-settings.json` and `.pi/goal-auditor.json` files are no longer read. Users must manually merge into the new file.
- **`loadGoalSettings` replaces `loadGoalAuditorConfig`** — the auditor now reads its config (provider, model, thinkingLevel, disabled) from the unified settings file via `loadGoalSettings()`. Old individual `loadGoalAuditorConfig`, `loadGoalAuditorFileConfig`, `saveGoalAuditorFileConfig`, `parseGoalAuditorConfig`, and `goalAuditorConfigPath()` functions removed from `goal-auditor.ts`.
- **Auditor env vars removed** — `PI_GOAL_AUDITOR_PROVIDER`, `PI_GOAL_AUDITOR_MODEL`, and `PI_GOAL_AUDITOR_THINKING_LEVEL` removed. Replaced with single `PI_GOAL_SETTINGS_FILE` env var that points at an alternative settings file path (relative to cwd or absolute). `PI_GOAL_DISABLE_TASKS` and `PI_GOAL_DISABLE_CONTRACTS` remain unchanged.
- **`/goal-settings` TUI updated** — now shows all settings in one list (disabled, provider, model, thinking_level, subtaskDepth, disableTasks, disableContracts) instead of a separate auditor-only sub-menu.

## [0.14.0] — 2026-05-28

### Added

- **Unified goal + task acceptance** — `propose_goal_draft` accepts an optional `tasks` array parameter (full task list structure). The confirmation dialog shows the goal objective AND proposed task list together in a single rich TUI view with box-drawing panel (`┌─ TASKS ───┐`), section headers, and hierarchical indentation for subtasks. One confirmation (single enter press) creates both the goal and its task list atomically. Backward compatible: existing `propose_task_list` flow unchanged.
- **Recursive sub-task system** — `GoalTask` type gains optional `subtasks?: GoalTask[]` (recursive — sub-tasks are full task records with id, title, status, evidence, completedAt, verificationContract, and their own subtasks). `GoalSettings` gains `subtaskDepth?: number` field (default 1) in `.pi/goal-settings.json`. Depth validation/policy in `goal-policy.ts` enforces the limit at all proposal points. `lightweightSubtasks?: boolean` flag allows parent completion without child enforcement.
- **Depth-validated proposal flow** — subtask depth is validated BEFORE showing the confirmation dialog (moves pre-dialog to match `propose_task_list` behavior). `findSubtaskDepthViolation` and `validateTaskListProposal` used in both `propose_goal_draft` and `propose_task_list`.
- **Subtask enforcement on complete/skip** — `complete_task` rejects when a task has pending full subtasks (`checkSubtasksComplete`). `skip_task` cascades skip to all child subtasks (`skipAllSubtasks`). Both use `findTaskInTree`/`updateTaskInTree` helpers.
- **Hierarchical task display** — `taskListBlock` in prompts renders subtask trees with indentation via `renderTaskTree`. `buildTaskSummary`/`taskSummaryBlock` recursive. Widget (`goal-widget.ts`) counts subtasks recursively in `countFlatTasks` and finds next pending task via BFS `findFirstPending`.
- **Scroll fix for proposal dialogs** — `runGoalQuestionnaire` suppresses hardware cursor during dialog (`setShowHardwareCursor(false)`) to reduce ~60fps ANSI cursor-positioning writes that fight manual scrolling. Cursor restored on dialog close. Affects `propose_goal_draft`, `propose_task_list`, and all goal questionnaire dialogs.
- **E2E test coverage** — unified acceptance flow (goal creation + task list + subtasks + verification contract, disk round-trip verified) and scroll fix (headless dialog path exercises cursor operations).
- **Subtask normalization/roundtrip** — `normalizeTaskList`, `normalizeTaskItem`, and `cloneGoal` handle recursive subtask structures.
- **Subtask depth edge cases** — tests for depth below 1, non-integer, negative, and missing config file defaults.

### Changed

- **`subtaskDepth` default is 1** — one level of nesting (tasks → subtasks). Set via `.pi/goal-settings.json`. No config file means default 1.

## [0.13.0] — 2026-05-28

### Added

- **Verification contract system** — goals and individual tasks can now define a `Verification contract:` section specifying what verification evidence is required before completion, enforced at both the prompt and tool level. Key properties:
  - **`Verification contract:` section** — when drafting a goal (via `propose_goal_draft` or `/goals-set`/`/sisyphus-set`), include a `Verification contract: <description>` section in the objective. The contract is extracted, stored on the goal record, and stripped from the visible objective text.
  - **`complete_goal` `verificationSummary`** — the old optional `testResults` parameter is replaced with a required `verificationSummary` (plain text). If the goal has a contract, the call is rejected unless `verificationSummary` is non-empty.
  - **Per-task contracts** — `propose_task_list` supports an optional `verificationContract` per task. `complete_task` gains an optional `verificationSummary` parameter; if the task has a contract, the summary is required.
  - **Prompt hardening** — `goalPrompt` and `continuationPrompt` include a VERIFICATION CONTRACT section instructing the agent to provide evidence against every contract item before calling `complete_goal`/`complete_task`.
  - **Auditor integration** — the auditor receives both the `verificationContract` and `verificationSummary` and cross-checks the agent's claims against real artifacts.
  - **Backward compatible** — goals/tasks without a `Verification contract:` section work exactly as before.

### Changed

- **`complete_goal` `testResults` removed** — fully replaced by `verificationSummary`. The deprecated `AuditorTestResults` interface is deleted; `AuditorVerificationEvidence` is the only interface used.
- **`buildGoalAuditorPrompt`** — now accepts `verificationSummary` instead of `testResults`; renders `<verification_summary>` and `<verification_contract>` blocks instead of `<test_evidence>`.

## [0.12.0] — 2026-05-27

### Added

- **Task list system** — goals can now include a structured task list with `propose_task_list`, `complete_task`, and `skip_task` tools. Key properties:
  - **`propose_task_list`** — agent proposes a task list to the user via a Confirm / Continue Chatting dialog (mirrors `propose_goal_draft` pattern). Stops the turn. Merges with existing tasks, preserving statuses of matching IDs.
  - **`complete_task`** — marks a task complete with optional evidence (≤200 chars). Does **not** stop the turn, allowing the agent to continue work.
  - **`skip_task`** — marks a task skipped with a required reason. Does **not** stop the turn.
  - **`complete_goal` task gate** — when `blockCompletion: true` and pending tasks exist, `complete_goal` surfaces a soft guard warning rather than blocking outright. The gate is prompt-level only; the agent can still complete.
  - **Ledger events** — `task_list_set`, `task_complete`, `task_skipped` events recorded for full traceability.
  - **Serialization** — tasks persisted as `## Tasks` markdown section in goal files with `[x]`/`[ ]`/`[~]` markers, evidence, skip reasons, and `blockCompletion` comment.
  - **Prompt injection** — `taskListBlock` renders the active task list in both `goalPrompt` and `continuationPrompt`, including the TASK GATE warning when `blockCompletion` is enabled and pending tasks exist.
  - **Widget display** — heading shows `N/M tasks`; body shows the next pending task or `All tasks complete`.
  - **Auditor integration** — task summary block included in auditor prompt's `<goal_details>`.
  - **Optional** — goals without a `taskList` work exactly as before.

### Changed

- **`update_goal` renamed to `complete_goal`** — the completion tool is now named `complete_goal` to make its sole purpose unambiguous (marking the goal complete). The old name `update_goal` sounded generic and tempted agents to call it when work was unfinished. Prompt guidelines on the renamed tool were tightened: added "Do NOT call complete_goal if any work remains, even if substantial progress was made." All internal references, tests, prompts, and documentation updated.

## [0.11.0] — 2026-05-27

### Removed

- **`apply_goal_tweak` fully removed** — replaced with `propose_goal_tweak`, a confirmation-dialog tool that mirrors `propose_goal_draft` exactly. The old `apply_goal_tweak` (which applied tweaks inline without user confirmation) is deleted entirely from source: constant, registration, imports, handler, and all references. The `/goal-tweak` flow now shows a Confirm / Continue Chatting dialog before applying the revision.

### Added

- **`propose_goal_tweak` tool** — registered alongside `propose_goal_draft`, available exclusively during `/goal-tweak` drafting. Uses `showProposalDialog()` and `buildTweakConfirmationText()` to present the current objective, change summary, and proposed new objective. On Confirm: writes the new objective, clears drafting state, terminates the turn. On Continue Chatting: keeps drafting active for further refinement.
- **Comprehensive test coverage** — 13 new tests across three layers:
  - Unit: `buildTweakConfirmationText` renders normal/sisyphus modes and edge cases (3 tests).
  - Integration: tool registration, schema validation, rejection gates (no goal set, no `/goal-tweak` flow), prompt guidelines, renderCall/renderResult (11 tests).
  - E2E: real `pi --fork --mode json` test verifying `propose_goal_tweak` is rejected without an active `/goal-tweak` drafting flow (1 test).
  - Total test count: 143 tests (up from 131), all passing, TypeScript zero errors.

### Changed

- **`/goal-tweak` notification** now says "started a `/goal-tweak` flow on `{objective}` — I'll draft the change and propose the revision for you to Confirm." reflecting the new confirmation pattern.
- **`syncGoalTools()` and `fullGoalToolVisibility()`** — `propose_goal_tweak` shown during tweak drafting, hidden otherwise. Removed dead `draftingHiddenWorkTools` constant referencing `TWEAK_APPLY_TOOL_NAME`.
- **`goalTweakDraftingPrompt`** guides the agent to use `propose_goal_tweak` with confirmation dialog.
- **Test assertions updated** in `goal-tool-names.test.ts`, `goal-draft.test.ts`, `goal-update-objective.test.ts`, `goal-prompts.test.ts` — all references to `apply_goal_tweak` / `TWEAK_APPLY_TOOL_NAME` replaced with `propose_goal_tweak` / `PROPOSE_TWEAK_TOOL_NAME`.

---

## [0.10.2] — 2026-05-26

### Removed

- **`updatedObjective` from `update_goal`** — the goal objective can no longer be changed through `update_goal`. The parameter is removed from the schema, `additionalProperties: false` enforces strict rejection of unknown params, and the Phase 1 handler block that processed it is deleted. Objective changes now go exclusively through `apply_goal_tweak`, gated behind user-initiated `/goal-tweak`.

### Changed

- **`update_goal` error message** — simplified to: `"update_goal requires status=complete when marking a goal complete."` (no more branching on `updatedObjective` vs `status`).
- **Prompt guidelines** — `update_goal` prompt, `goalPrompt()`, and `continuationPrompt()` now state the goal objective is **immutable** and instruct the agent to ask the user to run `/goal-tweak` to revise it.
- **Test coverage** — old quick-sync/combined e2e tests replaced with schema-rejection and completion-only mock-pi tests. 2 new source-inspection unit tests verify `additionalProperties: false` and absence of `updatedObjective`.
- **Docs** — `README.md` rewritten ("Goal objective is immutable" section). Agent and chain docs (`e2e-test-runner.md`, `e2e-test.chain.md`) cleaned up.

---

## [0.10.1] — 2026-05-26

### Added

- **`testResults` attestation** — the executor can pass structured test evidence (`exitCode`, `suiteName`, `output`, `timestamp`) via `update_goal({testResults})`. The auditor receives it as a `<test_evidence>` block and is instructed to check it before re-running test suites, skipping redundant re-runs.
- **Full test coverage for `testResults`** — 6 unit tests covering rendering of full/minimal/null evidence blocks, multi-line output indentation, non-passing exit codes, and the checklist instruction to check evidence before re-running. 1 integration test verifying the handler accepts `testResults` without error.

### Changed

- **`buildGoalAuditorPrompt` checklist renumbering** — when `testResults` is provided, the checklist has 5 items (with step 3 about checking test evidence). Without it, the checklist has 4 items (no evidence step), ensuring step numbers always align.

---

## [0.10.0] — 2026-05-26

### Added

- **Auditor progress visibility** — the auditor agent now has a `report_auditor_progress` tool to report its current step label (e.g. "Inspecting files...") and completion percentage at natural phase boundaries. The prompt instructs the model to use it at starting → inspecting → verifying → evaluating → reporting phases.
- **Progress bar widget** — when the auditor reports progress, the TUI widget renders a progress bar (`[████░░░░] 40%`) alongside the step label, giving the user a clear visual sense of completion.
- **Thinking phase awareness** — silent thinking phases (model reasoning without tool calls) are now detected via `thinking_start`/`thinking_end` stream events. The widget shows a distinct `⟡ thinking...` label with elapsed time and hides the Esc-to-skip hint during thinking.
- **`AuditorProgress` / `AuditorWidgetProgress` types** — extended with optional `label` and `percentage` fields for the progress tool and widget.
- **Widget tests for progress bar** — 5 new tests covering progress bar rendering at 0%/40%/100%, thinking phase display, step labels, undefined-percentage fallback, and narrow-width boundaries.

### Changed

- **`runGoalCompletionAuditor`** now passes the `report_auditor_progress` tool via `customTools` to the auditor agent session. Initial progress ("Starting audit..." / 0%) is emitted before the session starts. The `buildGoalAuditorPrompt` includes a "Progress reporting:" section with usage examples.
- **`renderAuditorWidgetLines`** — enhanced to display step label, progress bar, and thinking-phase icon/label. All existing display elements (spinner, tool name, output lines, Esc-to-skip) are preserved.

---

## [0.9.0] — 2026-05-26

### Added

- **`update_goal({updatedObjective})`** — the agent can now sync the goal objective mid-flight when user requirements change, without completing the goal. The `status` parameter is now optional, allowing a pure objective-update call. This ensures the completion auditor evaluates against the latest requirements.
- **`validateGoalUpdate()`** extracted to `goal-policy.ts` — validates that the target goal is active/paused (rejects null or already-complete goals with specific messages). Used by the handler and testable independently.
- **Comprehensive e2e test suite**: 131 tests covering function-level integration (12 tests, 9-scenario matrix + 3 edge-case gates), mock-pi handler tests (4), file-validity/chain checks (6), and real `pi --fork --mode json` fork tests (3 scenarios).
- **Deterministic fork tests**: the `--mode json` fork test uses `--append-system-prompt` + `--tools get_goal,update_goal` to force the AI model to always call the required tools. Validates `tool_execution_start`/`tool_execution_end` JSON events with field-level assertions — no free-text AI output parsing.

### Changed

- **Goal archival deferred until after agent turn completes**: `update_goal` marks the goal complete in-memory and writes an active file (not archived). The `turn_end` lifecycle hook detects completed goals and archives them — after the agent has received the audit/skip result. Previously archival happened inline within the tool handler, before the agent could see the result.
- **`buildCompletionReport` supports `auditSkippedReason`**: skip notifications (disabled auditor, Esc abort) are now included in the tool output text.
- **`accountProgress` guard**: skips `reconcileFocusedGoalFromDisk` for completed goals, preventing lifecycle conflicts.

### Fixed

- **Combined path correct ordering**: when `updatedObjective` + `status: "complete"` are passed together, the objective update is applied first, then the normal completion+audit flow runs against the updated objective.
- **Completion gate timing**: `turnStoppedFor` and `terminate: true` are no longer set for pure objective-sync calls — only for actual completions.

---

## [0.8.2] — 2026-05-26

### Fixed

- **Goal archival deferred until after agent turn completes**: previously, `update_goal` archived the goal file inline within the tool handler before the agent could see the audit result (or skip notification). Now the goal is marked complete in-memory and written as an active file (not archived) during `update_goal`, and archival happens at `turn_end` — after the agent has received the audit/skip result.

### Added

- **`buildCompletionReport` supports `auditSkippedReason`**: skip notifications (disabled auditor, Esc abort) are now included in the tool output text, ensuring the agent sees why the audit was skipped before the goal is archived.
- **Tests**: verify `writeActiveGoalFile` no longer auto-archives for complete status (deferred archival), and `buildCompletionReport` correctly handles `auditSkippedReason` with precedence over `auditorReport`.

---

## [0.8.1] — 2026-05-19

### Changed

- **Audit log messages clarified**: `extensions/goal.ts` — disabled/aborted audit messages now read naturally as goal completion notices ("Goal completed — auditor disabled in settings." / "Goal completed — auditor bypassed (user pressed Escape during audit).").

---

## [0.8.0] — 2026-05-17

### Added

- **C19 iteration-frustration benchmark**: new spec under `specs/` exercising the proposal-refinement cycle with repeated rejection scenarios.
- Spec metadata files: `PRODUCT.md`, `TECH.md`, `MILESTONES.md` for the C19 benchmark.

### Changed

- **Normalized proposal-refinement cycle language**: `extensions/goal-draft.ts`, `extensions/goal-questionnaire.ts`, and `extensions/goal.ts` — consistent terminology across the drafting/refinement pipeline.
- Updated test assertions (`tests/goal-draft.test.ts`) to match the new language.

---

## [0.7.2] — 2026-05-17

### Added

- Gallery image metadata and placeholder screenshot for `pi.dev/packages`.

---

## [0.7.1] — 2026-05-17

### Fixed

- Version metadata in package manifest after 0.7.0 release commit.

---

## [0.7.0] — 2026-05-17

### Added

- **Goal auditor lifecycle** (`feat(auditor)`):
  - `disabled` config flag to turn off auditing entirely.
  - Real-time progress callbacks during audit execution.
  - `audit_skipped` event type recorded in the ledger with reason + auditor metadata.
- **Auditor progress widget**: live spinner, tool tracking, and skip hint in the TUI.
- **Auditor integration**:
  - Escape-key handling during audit (skip with Esc, prevents cascading goal pause).
  - `createSession` factory wiring `AbortSignal` to `session.abort()`.
  - Audit abort detection (both thrown and non-thrown `session.prompt` aborts).
  - Goal completes on audit abort instead of leaving an open state.

### Fixed

- Audit cancellation loop: `confirmBypassAuditor` param respected, skip-once with `triggerTurn` mirroring disabled-bypass path.
- Corrected Esc-to-skip widget message to reflect actual behavior.

### Tests

- Unit tests for disabled config, `audit_skipped` events, and widget skip hint.
- Abort-scenario tests for `runGoalCompletionAuditor`.
- Post-prompt abort detection test.
- Goal policy test validating completion report includes full auditor output.

---

## [0.6.0] — 2026-05-12

### Added

- **Split goal intent and direct set commands**: `/goals-set` / `/sisyphus-set` — create and start a goal immediately from the supplied objective, skipping the discussion flow.

### Changed

- `specs/` directory excluded from npm package.

---

## [0.5.0] — 2026-05-12

### Removed

- Token budget system removed from the drafting runtime.
- **Simplified drafting runtime**: removed token-budget tracking and associated complexity.

---

## [0.4.1] — 2026-05-12

### Added

- **Visible audit dialogue**: the completion auditor now prints its dialogue into the conversation, giving full visibility into the audit reasoning.

---

## [0.4.0] — 2026-05-12

### Changed

- Goal runtime updates — internal refactoring and lifecycle improvements.

---

## [0.3.1] — 2026-05-12

### Added

- **Independent goal completion auditor**: standalone audit step that reviews goal completion before finalizing.

---

## [0.3.0] — 2026-05-12

### Fixed

- **Oracle goal lifecycle audit fixes**: corrected audit lifecycle handling in Oracle-based goal execution.

---

## [0.2.7] — 2026-05-12

### Added

- **Goal abort lifecycle**: proper abort handling for in-progress goals.

---

## [0.2.6] — 2026-05-12

### Changed

- Split goal internals — refactored monolithic goal module into focused sub-modules.

---

## [0.2.5] — 2026-05-12

### Added

- Full `/sisyphus` command now required (no short-form aliases that could cause ambiguity).

---

## [0.2.4] — 2026-05-12

### Changed

- Grouped goal widgets — reorganized widget components for maintainability.

---

## [0.2.3] — 2026-05-12

### Changed

- Simplified Sisyphus goal flow — streamlined the Sisyphus execution loop.

---

## [0.2.2] — 2026-05-12

### Fixed

- Simplified goal widget header — removed redundant status information from the widget display.

---

## [0.2.1] — 2026-05-12

### Added

- **Goal widget component**: initial TUI widget showing goal status in the editor.

---

## [0.2.0] — 2026-05-12

### Added

- **Componentized goal drafting UX**: `/goals` and `/sisyphus` drafting flow extracted into reusable components.

---

## [0.1.2] — 2026-05-11

### Fixed

- Built-in question tools now correctly prefixed to avoid naming collisions.

---

## [0.1.1] — 2026-05-11

### Added

- **Built-in goal questionnaire drafting UI**: interactive questionnaire for goal refinement before confirmation.

---

## [0.1.0] — 2026-05-11

### Added

- Initial release of pi-goal-x (fork of `@capyup/pi-goal`).
- Core goal lifecycle: draft, confirm, execute, pause, resume, complete.
- Two goal styles: regular goals and Sisyphus ordered-execution goals.
- Intent-before-run flow (`/goals`, `/sisyphus`).
- `propose_goal_draft` confirmation gate.
- Auto-continue loop with empty-turn guard.
- Schema-gated lifecycle transitions.
- Multiple open goals with session-local focus.
- Goal status overlay widget.
- MIT license.

<!-- Version links for navigation -->

[0.18.4]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.18.4
[0.18.3]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.18.3
[0.16.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.16.0
[0.15.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.15.1
[0.15.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.15.0
[0.14.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.14.0
[0.13.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.13.0
[0.12.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.12.0
[0.11.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.11.0
[0.10.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.10.2
[0.10.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.10.1
[0.10.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.10.0
[0.9.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.9.0
[0.8.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.8.1
[0.8.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.8.0
[0.7.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.2
[0.7.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.1
[0.7.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.0
[0.6.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.6.0
[0.5.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.5.0
[0.4.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.4.1
[0.4.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.4.0
[0.3.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.3.1
[0.3.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.3.0
[0.2.7]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.7
[0.2.6]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.6
[0.2.5]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.5
[0.2.4]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.4
[0.2.3]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.3
[0.2.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.2
[0.2.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.1
[0.2.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.0
[0.1.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.2
[0.1.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.1
[0.1.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.0
