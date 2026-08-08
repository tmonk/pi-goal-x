# Unified Dashboard

`pi-goal-x` renders one dashboard component in two presentation modes. The
above-editor widget, `/goal-status`, and the completion flow all derive from
the same presentation model (`extensions/widgets/goal-dashboard-model.ts`),
so they can never drift apart on data or terminology.

- **Compact mode** — a persistent summary above the editor while a goal is
  focused.
- **Expanded mode** — the full dashboard: task tree, current-task details,
  verification, and recent activity. This replaces the former task-list
  overlay; `Ctrl+Shift+T` now toggles between compact and expanded instead of
  opening a separate overlay.

Everything shown is derived from persisted goal state and the durable ledger:
progress, the current task, verification status, the audit result, and recent
activity are never fabricated for display.

## Compact mode

Always visible above the editor while a goal is focused:

```text
╭─ pi-goal-x ─ Add CSV export to reports ────────────────────────────────────────────────╮
│ goal: running [12m47s 18.2K] (+2 open)                                                 │
├─ Tasks · ✓3 done · 2 open ─────────────────────────────────── [████░░] · Sub 2/3 [██░] ┤
│ ✓ t1  Review reports page and data source                                              │
│ ✓ t2  Implement filtered CSV export                                                    │
│ ▸ t3  Add the download button ☑ ▸ 2/3                                                  │
│ · t4  Add documentation                                                                │
│ … +1 more task                                                                         │
│ Current  t3 · Add the download button                                                  │
│ Verify   Run npm test with zero failures.                                              │
│ File     .pi/goals/active_goal_g1.md                                                   │
╰─ Ctrl+Shift+T: expand tasks─────────────────────────── Ctrl+Shift+A: toggle auditor ● ─╯
```

Compact rows, in order:

1. Header (rounded corners): title. (Usage lives in the status line below,
   not in the header.)
2. Status: `goal: <status> [<elapsed> <tokens>] (+N open)` — the same
   terminology as the pi footer status line.
3. Token budget (when configured): `⛽ Budget 18.2K / 50K · 36%`.
4. Tasks header row: `Tasks · ✓N done · M open` with the compact task
   progress bar, then the current task's subtask bar beside it
   (` · Sub done/total ` + bar — the word `Sub` is dropped in narrow mode so
   the full counts still fit at 50 columns, and the segment is omitted
   entirely in minimal mode, where the counts and task bar alone use all
   available space). `N` counts top-level tasks complete **or skipped** — a
   skipped top-level task counts as done (§9.1) — and `M` counts pending
   tasks. The subtask segment appears only when the current task has direct
   children. The whole header row is neutral gray (label, counts, bar fill,
   and empty cells) so nothing in the progress info is colourful.
6. Task list section: the top-level tasks shown by default in **pastel
   amber** (`mdHeading`) with colour-coded markers and ids (✓ complete muted
   green, ▸ current teal, ~ skipped gray, · pending amber), an aligned id
   column, truncated amber titles, and a `… +N more` overflow line when the
   list is longer than the row budget (5 rows at wide, 4 medium, 3 narrow, 2
   minimal). Tasks that have direct subtasks show a muted `▸ done/total`
   marker at the end of their row (leaf tasks show none). The current task
   is fully highlighted in the theme's accent color (marker, id, title). The
   whole box chrome — top/bottom frame, left/right edges, corners and
   interior rules — is drawn in one tone: the theme's neutral gray
   (`muted`). No blue tinge.
6. Current task: `Current  t3 · Add the download button` (id and title in the
   accent color).
7. Goal-level verification contract (first line, truncated).
8. Blocked or paused detail (reason, suggested action).
9. Active (or archived) goal file path.
10. Footer with the expansion shortcut. The whole footer line — leading dash,
    shortcut hint and trailing fill — is drawn in one frame tone (the
    neutral-gray `muted`), so the color spans the full width with no two-tone
    split; the header line is likewise one tone with only the `pi-goal-x`
    brand in accent. The auditor status lives in the bottom-right of this
    border: a single `●` — green when the focused goal's independent auditor
    is on, gray when off — drawn right before the `╯` corner. In wide/medium
    layouts the footer also right-aligns a `Ctrl+Shift+A: toggle auditor`
    note beside the dot, making explicit that the shortcut turns the auditor
    on and off; narrow and minimal keep just the dot. `Ctrl+Shift+A` toggles
    the auditor per-goal (persisted, `auditor_toggled` ledger event,
    dashboard refresh, notification; inert with no focused goal, a goal modal
    open, or a complete goal). The expanded dashboard does not render the
    auditor indicator.

When every top-level task is done, the current line reads
`Current  All tasks complete`. With `disableTasks` enabled the task rows are
omitted entirely.

## Expanded mode

`Ctrl+Shift+T` expands the same component:

```text
╭─ pi-goal-x ─ Add CSV export to reports ─────────────── 12m47s · 18.2K tok ─╮
│ Status: ● In progress · Focused: yes · Other goals: 2                      │
│ File: .pi/goals/active_goal_...                                             │
├─ Progress ──────────────────────────────────────────────────────────────────┤
│ [██████░░░░] 3/5 tasks · 60%                                               │
├─ Tasks ─────────────────────────────────────────────────────────────────────┤
│ ✓ t1  Review reports page and data source                                  │
│ ✓ t2  Implement filtered CSV export                                        │
│ ▸ t3  Add the download button ☑                                            │
│   ✓ t3.1  Add loading state                                                 │
│   ✓ t3.2  Generate timestamped filename                                    │
│   · t3.3  Add error handling                                                │
│ · t4  Add documentation                                                    │
│ ~ t5  Add and run tests                                                    │
├─ Current task ──────────────────────────────────────────────────────────────┤
│ t3 · Add the download button                                               │
│ Subtasks [███████░░░] 2/3 · 67%                                            │
│ Contract: The button downloads a CSV using the active filters.             │
├─ Verification ──────────────────────────────────────────────────────────────┤
│ Run npm test with zero failures.                                            │
├─ Recent activity ───────────────────────────────────────────────────────────┤
│ ✓ Completed “Implement filtered CSV export”. — Done                        │
│ ▸ Started “Add error handling”.                                             │
╰─ Esc/Ctrl+Shift+T: collapse ────────────────────────────────────────────────╯
```

Task markers (§9.2): `✓` complete, `~` skipped, `▸` current, `·` pending.
A `☑` suffix marks a task that carries its own verification contract; the full
contract is shown in the current-task block.

When no persisted current task exists, the dashboard falls back to the first
pending task for display and marks it as inferred — the fallback is never
persisted.

## Scrolling the task list

Both views show the task list as a **window** over the plan-ordered list, and
by default the window is **anchored to the most recently completed task** —
the viewport is "scrolled down" so recent completions (by `completedAt`) are
visible instead of always showing the earliest tasks. With nothing completed
the window starts at the top; when a new task completes the window re-anchors
to it. `↑ N more tasks` / `… +N more tasks` indicator rows mark rows hidden
above and below the window.

pi has no separate focus — the prompt editor owns the plain arrow keys — so
the two views scroll differently:

| View | Key | Action |
| --- | --- | --- |
| Expanded (modal) | `↑` / `↓` | Scroll one task row |
| Expanded (modal) | `PgUp` / `PgDn` | Scroll one page of task rows |
| Expanded (modal) | `Home` / `End` | Jump to the top / bottom of the list |
| Compact (inline) | `Ctrl+Shift+↑` / `Ctrl+Shift+↓` | Scroll one task row |
| Compact (inline) | `Ctrl+Shift+PgUp` / `Ctrl+Shift+PgDn` | Scroll one page |
| Compact (inline) | `Ctrl+Shift+Home` / `Ctrl+Shift+End` | Jump to the top / bottom |

While the expanded dashboard is open it is modal and owns the plain arrow
keys (like the session tree or model selector); `Esc` collapses it. The
compact widget never touches the editor's arrows — it scrolls with the
`Ctrl+Shift` chords, which pi leaves unbound, so typing and navigation are
never hijacked. The chords are consumed only when the compact list actually
overflows its viewport; on a short list they pass through unused. When the
list overflows, the compact footer advertises the chords
(`Ctrl+Shift+↑↓: scroll`). `/goal-status` renders the same anchored window as
a static snapshot (it is not interactive). The window and its indicators are
width-safe at every layout width.

## Status states

| Symbol | Status | Shown for |
| --- | --- | --- |
| `●` | In progress | active goal with auto-continue on |
| `○` | Idle | active goal with auto-continue off |
| `◐` | Paused (user/agent) | paused goal, with reason |
| `⊘` | Blocked | blocked goal, with blocker and suggested action |
| `⛽` | Budget limited | goal at its token budget, with usage detail |
| `✓` | Complete | completed goal, before/after archival |

Status labels are always explicit words, so the dashboard stays readable
without the symbols.

## Unfocused state

When open goals exist but none is focused:

```text
╭─ pi-goal-x ─ Goal focus required ───────────────────────────────────────────╮
│ 3 open goals are available.                                                │
│ Run /goal-focus to choose the goal for this session.                       │
╰─────────────────────────────────────────────────────────────────────────────╯
```

## Audit view

During an independent completion audit the widget switches to a structured
audit dashboard with the same visual system:

```text
╭─ Independent completion audit ─ anthropic/claude-sonnet:high ─── 2m18s ─╮
│ ✓ Objective and success criteria                                         │
│ ✓ Verification contracts                                                 │
│ ✓ Tasks and recorded evidence                                            │
│ ◌ Workspace inspection                                                   │
│ · Final decision                                                         │
│ [███████░░░] 72%                                                         │
╰─ Esc: stop audit ─────────────────────────────────────────────────────────╯
```

Raw auditor tools and output are hidden by default; they appear only in
expanded/debug audit mode or when the audit failed and diagnostics are needed.

After the audit, a result card shows the outcome:

```text
╭─ Audit result ─ APPROVED ─────────────────────────────────────────────────╮
│ ✓ Objective satisfied.                                                    │
│ ✓ Verification requirements satisfied.                                    │
│ ✓ Required tasks and evidence accepted.                                   │
╰────────────────────────────────────────────────────────────────────────────╯
```

A rejected audit keeps the goal open, shows `CHANGES REQUIRED` with the
auditor's findings, and returns to the normal dashboard so work can continue.

## Keybindings

| Key | Action |
| --- | --- |
| `Ctrl+Shift+T` | Toggle the dashboard between compact and expanded |
| `Ctrl+Shift+A` | Toggle the focused goal's independent auditor on/off (persisted per-goal; inert with no goal, a goal modal open, or a complete goal) |
| `↑` / `↓`, `PgUp` / `PgDn`, `Home` / `End` | Scroll the expanded task tree (see [Scrolling the task list](#scrolling-the-task-list)) |
| `Ctrl+Shift+↑` / `Ctrl+Shift+↓`, `Ctrl+Shift+PgUp` / `Ctrl+Shift+PgDn`, `Ctrl+Shift+Home` / `Ctrl+Shift+End` | Scroll the compact task list |
| `Esc` | Collapse the expanded dashboard; otherwise pause the goal |
| `Esc` (during audit) | Stop the audit and choose to continue working or complete without audit |

Configure the three task shortcuts with `keybindings.dashboard.toggleExpand`,
`keybindings.dashboard.scrollUp`, and `keybindings.dashboard.scrollDown` in
`.pi/pi-goal-x-settings.json`. The defaults are `ctrl+shift+t`,
`ctrl+shift+up`, and `ctrl+shift+down`.

## Width behavior

Layout modes (§5.5):

- **Wide (≥100 columns):** full border, multiple fields per line, full task
  titles, wider progress bars, current-task details.
- **Medium (70–99):** mostly one field per line, shorter bars, truncated
  paths and contracts.
- **Narrow (50–69):** compact border, short labels, reduced metadata, one
  task line at a time.
- **Very narrow (<50):** the essential summary only — status, task progress,
  the current task, and the verification contract.

The renderer never emits a line wider than the terminal width: all alignment
and truncation is visible-width aware (ANSI colors, Unicode, and double-width
characters included). Golden tests assert `visibleWidth(line) <= width` for
every rendered line at 40, 50, 60, 80, 100, and 140 columns.

## `/goal-status`

`/goal-status` renders the same model as the widget.

- Standard mode: a static compact-dashboard rendering, current-task details,
  recent activity, and the last audit result. No effective-settings noise.
- `/goal-status verbose`: goal id, revision, full objective, the complete
  task tree with full evidence and contracts, recent ledger history, token
  budget detail, pause/blocker detail, active and archived paths, the last
  audit report, and effective settings with provenance.

## Migration behavior

The current-task focus is a new **optional** persisted field
(`currentTaskId`) on goal records.

- Legacy goal files load without it and are **never rewritten** just because
  the field is absent.
- A persisted `currentTaskId` is accepted only when it references an existing
  *pending* task; it is cleared when that task is completed, skipped, or
  removed during normalization.
- Task-list restructuring preserves the current task only while its id
  remains pending; otherwise the focus clears and the dashboard recomputes.
- For display only, the dashboard may infer the first pending task as the
  current task and marks it as inferred.

## Compatibility

- Existing goal-file formats, archived goals, settings, slash commands, and
  direct-goal behavior are preserved.
- The task-overlay shortcut is retained but now expands the unified
  dashboard; the separate overlay registration is removed.
- Headless behavior remains functional without TUI rendering, and
  audit-disabled completion remains explicit and distinct from approval.
