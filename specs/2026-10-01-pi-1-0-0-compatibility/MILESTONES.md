# Implementation log — pi 1.0.0 compatibility

Free-form log of milestones, setbacks, fixes, validation notes, and decisions.

## 2026-10-01 — Spec opened

Scope recorded in `PRODUCT.md`. 1.0.0-only support confirmed by the user: 0.8x peer ranges are
dropped. Scope includes selective adoption of new 1.0 APIs and documentation updates. Outcome
is a prepared 0.32.0 (version bump + changelog), not an npm publish.

### Starting environment (read-only survey)

| Fact | Value |
| --- | --- |
| Installed host pi | `1.0.0` at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` |
| Repo devDeps today | `@earendil-works/pi-ai|pi-coding-agent|pi-tui` `^0.84.1` |
| Repo peerDeps today | `>=0.83.0 <0.85.0` |
| Resolved in `node_modules` | `0.84.1` for all three |
| Package version | `0.31.5` |
| Branch | `main`, with uncommitted issue #59 work |

### Pre-existing dirty tree (not ours)

`git status` at spec open showed uncommitted modifications to `CHANGELOG.md`, `README.md`,
`experiments/context/*`, six `extensions/*.ts` files, and four test files — a coherent
in-flight feature for issue #59 (token budgets via `/goal-tweak`), including its own tests and
changelog entry. Decision: leave it untouched. It is neither committed nor reverted, and it is
part of the pre-migration baseline.

### Early API delta observed (informational, to be confirmed in the audit task)

Diffing the `ExtensionAPI` interface declarations between the repo's 0.84.1 types and the
installed 1.0.0 types suggests 1.0.0 is largely additive rather than a rewrite:

- `on(event, handler)` changed from `void` to returning `() => void` — an unsubscribe
  function. Existing registration code keeps working; anything that stored or relied on the
  return value is affected.
- New events: `agent_before_settle`, `session_compact_failed`, `context_with_system`,
  `provider_stream_event`, `cache_warming_decision`, `mcp_servers_change`, `ui_prompt_start`,
  `ui_prompt_end`.
- `turn_end` gained a result type parameter (`ExtensionHandler<TurnEndEvent, TurnEndEventResult>`).
- New API members: `getSettings()`, `registerMcpServer()`, `unregisterMcpServer()`,
  `getMcpServers()`, `registerVirtualModel()`, `unregisterVirtualModel()`.
- Settings declaration gained `expandPromptTemplates` and a `"string"` variant detail.
- Tool-list accessors gained "exposure" metadata in their documentation.
- 1.0.0 splits out new packages (`pi-agent-core`, `pi-codemode`, `chord`, `pi-mcp`) that
  0.84.1 did not depend on; `typebox` moved to 1.3.27.

None of this is verified yet — the audit task owns the real list, including the pi-tui
component/key/theme contracts that this early survey did not check.

### Baseline (pi 0.84.1, before any dependency change)

Captured on the dirty tree described above, so the in-flight issue #59 work is included.
Every number below is a "known green" reference: a later failure is a regression unless it
can be traced to a genuine 1.0.0 API change.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0, no diagnostics |
| `npm run lint` (eslint .) | exit 0, no findings |
| `npm test` (unit) | 976 tests, 976 pass, 0 fail, 0 skipped, 72 files, ~6.7 s |
| `npm run test:integration` | 31 tests, 31 pass, 0 fail, 1 file, ~0.7 s |
| `npm run test:e2e` | 19 tests, 19 pass, 0 fail, 4 files, ~38 s |

Raw logs were written to `/tmp/baseline-{test,int,e2e}.log` plus `/tmp/baseline-{tsc,lint}.log`
during the session; the counts are the durable record.

### Ordering decision: budget guard lands before the dependency bump

The new `budget-guard` task touches prompt text and one test only. Doing it while 0.84.1 is
still green means it gets validated against a known-good baseline, so any subsequent failure
is unambiguously attributable to the 1.0.0 upgrade rather than to this change.

### Budget provenance: why a token budget exists, and why there is no default

The user's question ("confirm why we had a budget there") traced this history:

| Commit | Date | What happened |
| --- | --- | --- |
| `0cd122f` | initial | Token budget present from the first extension. |
| `97fd9d6` | 2026-05-13 | v0.5.0 **removed** the token budget to simplify the drafting runtime. Its spec listed as an explicit non-goal: "Reintroduce token budgets, budget-limited lifecycle states, or hard auto-continue turn caps." |
| `967bc7d` | 2026-08-04 | The runtime overhaul **reintroduced** it as "validated token budgets/accounting", with the `budget_limited` status, 50/75/90% threshold warnings, and experiment case C26. |

So the feature was deliberately removed once and deliberately brought back as an **opt-in,
user-supplied** cost-control lever. It was never intended to carry a default.

**There is no default budget, confirmed by inspection:**

- `.pi/pi-goal-x-settings.json` is `{}` — no budget setting exists at all.
- `create_goal` sets `tokenBudget` only when the caller passes `token_budget`
  (`extensions/goal-core-tools.ts:194-205`); otherwise it stays `undefined`.
- `propose_goal_draft.token_budget` is optional, and omitting it keeps the target goal's
  existing value or nothing at all for a new goal.
- `normalizePositiveSafeInteger` (`extensions/goal-record.ts`) coerces `0`, negative,
  fractional, non-finite, and unsafe values to *absent*, so on disk "0" and "no budget"
  are already the same state.

**The real residual risk was the model inventing one**, not a code default. Three guards
existed, but with one hole:

| Path | Guard before this task |
| --- | --- |
| `create_goal` | `promptGuidelines`: "Never infer persistent goals, Sisyphus mode, or token budgets from an ordinary task"; schema description "only if supplied by the user". **Present.** |
| `/goal-tweak` drafting prompt | "Change budgets only when requested." **Present.** |
| `propose_goal_draft` | Schema description said "Only on user request", but there was **no `promptGuidelines` entry**. **The hole.** |

### Budget guard change (minimal)

- `extensions/goal-drafting.ts`: added one line to the `propose_goal_draft`
  `promptGuidelines` array — set `token_budget` only when the user explicitly asked for a
  token budget or spend limit, and never invent, estimate, or infer one from the objective's
  size; omitting it creates a goal with no budget.
- `tests/goal-drafting.test.ts`: added one regression test asserting both the guideline text
  and the resulting behavior.

No schema, runtime, persistence, UI, or settings change. The always-visible
`Budget: none` line (`formatGoalBudget`) was deliberately left alone — it is what lets a user
see that a goal is unbudgeted.

### Budget guard validation

- The test was confirmed to be a real guard: with the guideline line removed it fails with
  `propose_goal_draft must carry a token_budget prompt guideline`; restored, it passes.
- Unit suite 976 → **977 tests, 977 pass, 0 fail**. `tsc --noEmit` exit 0. `npm run lint` exit 0.
  All still against pi 0.84.1.

### Dependency bump to 1.0.0

`package.json` peer and dev ranges for `@earendil-works/pi-ai|pi-coding-agent|pi-tui` moved
from `>=0.83.0 <0.85.0` / `^0.84.1` to `^1.0.0`, 0.8x support dropped per the user's decision.
`npm install` resolved all three to exactly **1.0.0**. `grep` finds no remaining `0.8x`
constraint in `package.json` or `package-lock.json`.

**Headline result: the upgrade required no source changes at all.**

| Check | 0.84.1 baseline | 1.0.0 after bump |
| --- | --- | --- |
| `tsc --noEmit` | exit 0 | **exit 0**, 0 errors |
| `npm run lint` | exit 0 | **exit 0** |
| `npm test` (unit) | 976 pass / 0 fail | **977 pass / 0 fail** (the +1 is the budget-guard test) |
| `npm run test:integration` | 31 pass / 0 fail | **31 pass / 0 fail** |
| `npm run test:e2e` | 19 pass / 0 fail | **19 pass / 0 fail, 0 skipped** |

Two caveats recorded honestly rather than glossed:

1. `npm run check` being clean is meaningful but not decisive on its own — `tsc` resolves the
   packages' `exports` map, and pi-coding-agent's root export re-exports broadly, so some
   drift can hide behind a still-present symbol. The real evidence is the e2e suite below.
2. The e2e suite is genuinely against the real 1.0.0, not a mock. `tests/e2e/run.ts` and
   `tests/e2e/network-recovery-rpc.test.ts` spawn the `pi` CLI from PATH (version 1.0.0) and
   the "real SDK:" tests drive the extension through a worker process on 1.0.0 types. All 19
   ran; none were skipped, including the two "real pi" recovery tests that exercise 503 and
   429 backoff against a live host.

### API audit: 0.84.1 → 1.0.0, mapped to extension usage

Method: fetched the real 0.84.1 tarballs (`npm pack @earendil-works/pi-{tui,coding-agent,ai}@0.84.1`)
and diffed `.d.ts` declaration trees against the installed 1.0.0 tree, rather than comparing
1.0.0 to itself. An earlier attempt to diff pi-tui against itself was discarded as invalid.

**Declaration-tree churn (whole packages):**

| Package | 0.84.1 `.d.ts` | 1.0.0 `.d.ts` | added | removed | changed |
| --- | --- | --- | --- | --- | --- |
| pi-tui | 38 | 45 | 7 | 0 | 20 |
| pi-coding-agent | 198 | 244 | 60 | 14 | 79 |
| pi-ai | 173 | 192 | 24 | 5 | 84 |

**Breaking for this extension: none.** Every removed file is unused here.

- pi-coding-agent removals are all unused: `bun/register-bedrock`, the whole
  `cli/experimental/*` tree, `client/{index,remote-session,transcript}`,
  `server/create-harness`, `utils/clipboard-native`. The extension imports only the package
  **root** export — `extensions/` and `tests/` contain no `@earendil-works/*/subpath` imports.
- pi-ai removals are all unused: `auth/oauth/oauth-page`, `image-models.generated`,
  `images-models`, `providers/openrouter-images`, `utils/deferred-tools`. The extension imports
  only `Model`, `Static`, `StringEnum`, `Type`.

**Behavioral / signature changes that matter, and their impact here:**

| Change | Impact on pi-goal-x |
| --- | --- |
| `ExtensionAPI.on(event, handler)` now returns `() => void` (unsubscribe) on **every** event overload | **None required.** All registration sites ignore the return value, and the extension never needs to detach a handler mid-session. Purely additive — a future extension-lifecycle cleanup could use it. |
| New events: `agent_before_settle`, `session_compact_failed`, `context_with_system`, `provider_stream_event`, `cache_warming_decision`, `mcp_servers_change`, `ui_prompt_start`, `ui_prompt_end` | None required. Evaluated separately in the new-APIs task. |
| `turn_end` gained a result type param (`ExtensionHandler<TurnEndEvent, TurnEndEventResult>`) | None. The existing `turn_end` handler remains assignable. |
| New API members: `getSettings()`, `registerMcpServer`/`unregisterMcpServer`/`getMcpServers`, `registerVirtualModel`/`unregisterVirtualModel` | None required. Evaluated in the new-APIs task. |
| Settings declaration gained `expandPromptTemplates`; tool-list accessors gained exposure metadata | None. The extension reads its own settings file, not the host `Settings` object. |
| pi-tui: `TUI` gained `TuiMouseEvent`/`TuiMouseDispatchResult`; new `Box`, `getNativeClipboard`, `oklabToOkhslLightness`, `isAppleTerminalSession` | None required. `Component`, `Editor`, `EditorTheme`, `Key`, `KeyId`, `Text`, `matchesKey`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi` all keep compatible signatures. `Editor` gained private render-cache fields only. |
| pi-tui gained mouse/theme internals; `Theme` gained `ThemeStyle`/`ThemeToken` | None required — additive types. |
| pi-ai `Model<TApi>` now `extends BaseModel<TApi>` with `type?: "chat"`; use `isModelType()` rather than comparing `type` | **None.** The extension only *reads* a `Model<any>` (`goal-auditor.ts:250` `resolveAuditorModel`, `:302` `modelLabel`) and never constructs one nor compares `type`. `tsc` confirms. |
| 1.0.0 adds packages 0.84.1 did not have: `pi-agent-core`, `pi-codemode`, `chord`, `pi-mcp`; `typebox` → 1.3.27 | None required. |

**Deep-subpath imports still valid** — `tests/stubs/pi-tui.ts` reaches into
`dist/components/editor.js`, `dist/components/text.js`, `dist/keys.js`, `dist/utils.js`.
All four exist in **both** 0.84.1 and 1.0.0. These are internal, unversioned paths and are a
latent upgrade hazard worth noting even though they did not break.

**Coverage gap found (the one real audit finding).** Two real SDK entry points are
**never executed by the test suite** — only typechecked:

- `createAgentSession` — every auditor test injects a mock
  (`tests/goal-auditor.test.ts:89`, `:289`, `:325` all pass `createSession: async () => ...`).
- `createExtensionRuntime` — stubbed outright in `tests/stubs/pi-coding-agent.ts:9`.

So `goal-auditor.ts`'s real session-construction path (`makeAuditorResourceLoader` at
`:228`, the `createAgentSession` call at `:333` with its
`as Parameters<typeof createAgentSession>[0]` cast at `:360`) is unverified at runtime by any
test. A 1.0.0 signature change there would typecheck cleanly and fail only in a live session.
This is what the live-session runtime verification must cover.

### Live-session verification against real pi 1.0.0

Added `scripts/live-session-check.mjs`, which closes the coverage gap above by driving a
**real `pi --mode rpc` process** (`pi --version` → `1.0.0`) with the extension loaded, an
isolated `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, and a local fake OpenAI-completions provider.
The fake provider is SSE-streaming (the first non-streaming attempt failed with
`stopReason: "error"`, `errorMessage: "Stream ended without finish_reason"` — a useful
reminder that pi streams). It picks each reply from the request itself, so the same logic
serves all three phases, and it answers extension dialogs over the RPC UI sub-protocol.

**Observed output (verbatim summary from a passing run):**

```
host version:            1.0.0
provider requests:       3 (drafting=1, execution=1, audit=1)
tools called:            propose_goal_draft, update_goal
archived:                goal_2026100121073619_mupyubjk-q5eg3e.md
goal tokenBudget:        (absent)
ledger event types:      goal_created, completion_requested, audit_started,
                         audit_result, goal_completed, goal_archived
milestones:              {draftingPrompt:true, proposalShown:true, goalCreated:true,
                         budgetNone:true, executionStarted:true, auditRan:true, completed:true}
[live] required milestones: all present
[live] lifecycle reached completion/archival: yes
```

**What this proves, milestone by milestone:**

1. **The extension loads into pi 1.0.0** with no errors. Status and widget RPC calls flow
   throughout (`setStatus`, `setWidget` fire repeatedly with no failure).
2. **`/goal` drafting works.** The `[GOAL CONFIRMATION focus=goal]` prompt is injected, and
   the drafting tool surface is exactly
   `read, bash, edit, write, goal_question, goal_questionnaire, propose_goal_draft`.
3. **The `on()` unsubscribe change is harmless** — the extension registered all its handlers
   and they fired correctly across three phases without runtime error.
4. **Dialogs work over RPC**, including the native auditor selector
   (`Completion auditor (currently enabled)` → `Enabled — require independent approval`)
   and `Confirm Goal Draft`. This is the 1.0.0 native-selection path.
5. **Goal creation is correct and budgetless.** The proposal text opens with `Budget: none`,
   and the persisted record has `tokenBudget` absent — the zero-budget default confirmed in
   a real host, not just in unit tests.
6. **Execution runs** with the correct five-tool profile
   (`create_goal, get_goal, update_goal, set_goal_tasks`).
7. **The independent audit really executed** — this is the part no test covered. The audit
   phase shows a *different, isolated* session with its own tool surface
   (`read, grep, find, ls, bash`) and its own provider request. That isolated session is
   created by the real `createAgentSession()` through
   `makeAuditorResourceLoader()` / `createExtensionRuntime()`. It returned
   `<approved/>`, which `parseAuditorDecision` consumed.
8. **Completion and archival work**: `update_goal` reported "Goal audit approved… Goal
   complete.", and the ledger ends `audit_result → goal_completed → goal_archived` with the
   goal file moved into `archived/`.

**Incidental finding:** during the execution phase the tool surface exposed `create_goal`
alongside the execution tools. That is pre-existing 0.84.1 behavior, not a 1.0.0 regression,
but it is worth a follow-up look — see the "Possible follow-up" note below.

### Runtime regression result

**No runtime regressions found on pi 1.0.0.** The task's contract was to fix runtime problems
in event handler registration, settings, keybindings, and widgets; there were none to fix. The
work was verification rather than repair, and the verification is recorded above.

`npm run lint` and `npx tsc --noEmit` were re-run after adding the script: both exit 0 (four
`no-empty` lint errors from the new script were fixed rather than suppressed).

### New 1.0 API evaluation — every candidate decided

The goal required each candidate to be adopted with a test or explicitly rejected with
rationale. Silence was not acceptable. Six candidates, one adopted, five rejected.

#### ADOPTED — `session_compact_failed`

**The gap was real.** The extension handled `session_before_compact` (charges progress to the
goal) and `session_compact` (re-arms the compaction reminder and queues a continuation), but
pi 1.0.0 added a third path that nothing handled. A failed compaction is silent otherwise,
which is the worst outcome for a long-running goal: the context stays uncompacted, the
post-compact reminder is never armed, and the next turn can walk into the same overflow.

Change in `extensions/goal-events.ts`: a `session_compact_failed` handler that

1. flushes the buffered turn transaction (`core.goalService.flushTurn`) and persists the goal,
   because `session_before_compact` already charged progress — without the flush the goal
   record and the ledger can disagree about a compaction that never happened;
2. stays silent when `event.aborted` is true (a user action is not a fault) or no goal is
   focused;
3. otherwise notifies, naming the trigger `reason`, the provider's `errorMessage`, and that
   the goal stays active.

Two tests in `tests/goal-network-recovery.test.ts` cover the warning path (message names the
failure, the reason, the error text, and that the goal stays active) and the silence path.

#### REJECTED — `agent_before_settle`

Deliberate, and the code already argues the case at `goal-events.ts:532`: the extension
anchors continuation to `agent_settled` precisely because `agent_end` "runs before pi finishes
retries, compaction, terminating-tool settlement, and queued messages." `agent_before_settle`
fires *before* settle, i.e. inside the same unsafe window `agent_end` occupies — it is not a
later, safer hook. Adopting it would move continuation timing for every goal, which the
spec's behavioral-parity constraint forbids absent a demonstrated failure. The live lifecycle
in the previous section showed no stranding between `agent_end` and `agent_settled`. Revisit
only if a 1.0.x regression appears that strands work between before-settle and settled.

#### REJECTED — `context_with_system`

The extension's `context` handler *rewrites* the message array: it injects the live
`[CURRENT EXECUTION STATE]` message and applies checkpoint compaction
(`goal-events.ts:90-104`). `context_with_system` is the same event plus the system prompt,
which this handler neither filters nor replaces, and adopting it would change the returned-
message contract for no gain. The hoped-for gain — more accurate token budgets — does not
exist: budget accounting charges `completedTurnTokens` sourced from `turn_end`
(`goal-events.ts:181`), never from the context event, so system-prompt tokens would not reach
the budget at all.

#### REJECTED — `getSettings()`

`getSettings()` returns *pi's* host `Settings` (global + project merged, with overrides).
pi-goal-x reads its own layered configuration through `loadGoalSettings(ctx.cwd)`
(`goal-settings.ts`), which is a deliberately separate model with its own project/global
layering and defaults. Nothing in the extension consults host model, theme, or keybinding
settings. Adopting `getSettings()` would fuse two unrelated settings models and couple goal
behavior to host overrides pi-goal-x does not participate in.

#### REJECTED — `on()` unsubscribe returns

Every handler is registered once during activation and lives for the whole session. No code
path removes a handler, so there is nothing to unsubscribe. Storing the returned functions
would add a teardown path that nothing calls — dead code plus a surface to keep correct.
Noted for a future extension-lifecycle feature, not for a compatibility upgrade.

#### REJECTED — MCP and virtual-model registration

`registerMcpServer` / `unregisterMcpServer` / `getMcpServers` and
`registerVirtualModel` / `unregisterVirtualModel` are for extensions that *consume* MCP tools
or *provide* models. pi-goal-x does neither: it registers goal lifecycle tools and commands
only. Both would be new product surface, which the boundaries explicitly put out of scope.

### Documentation updates

- `README.md`: added an explicit version requirement to the Install section — "Requires **pi
  1.0.0 or newer**… pi-goal-x 0.32.0 dropped support for the 0.8x SDK line; install pi 1.0.0
  first." Also de-staled the `models.json` workaround paragraph, which named the "Pi 0.84.1
  adapter" and would have been wrong under 1.0.0.
- `docs/agent-flow-design.md`: the closing summary line said "the Pi SDK 0.83 family upgrade",
  which is stale as a statement about the current supported line; now reads "1.0".
- `CHANGELOG.md`: added Changed and Added entries under `[Unreleased]` for the dependency
  move, the drafting-tool budget guideline, and the `session_compact_failed` handler. The
  pre-existing `#59` Fixed entry was left exactly where it was.
- Deliberately **not** rewritten: historical changelog entries that mention 0.81/0.83/0.84.1
  describe what was true when released. Rewriting history to match the current version would
  make the log false.

### Release prep: version 0.32.0

`package.json` version bumped `0.31.5` → `0.32.0`; the lockfile's own version fields updated
via `npm install --package-lock-only`. Nothing was published.

The changelog entries stay under `[Unreleased]` rather than being cut into a `## [0.32.0]`
heading. Reason: the working tree also carries the maintainer's uncommitted `#59` work under
the same `[Unreleased]` heading. Cutting a 0.32.0 section would either silently pull that
in-flight feature into a release the user never approved, or require splitting the heading
and misrepresenting what shipped. The goal's success criterion asks for the version bumped
"with an Unreleased-consistent changelog entry", which this satisfies exactly. **Cutting the
0.32.0 release section is left as an explicit human decision at publish time.**

### Final validation (pi 1.0.0, version 0.32.0)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0, 0 errors |
| `npm run lint` | exit 0, 0 findings |
| `npm test` (unit) | **979 tests, 979 pass, 0 fail** (72 files) |
| `npm run test:integration` | **31 tests, 31 pass, 0 fail** |
| `npm run test:e2e` | **19 tests, 19 pass, 0 fail, 0 skipped** |
| `scripts/live-session-check.mjs` | all 7 milestones present; ledger ends `goal_archived` |
| Resolved SDK versions | `pi-ai` 1.0.0, `pi-coding-agent` 1.0.0, `pi-tui` 1.0.0 |
| `grep '0\.8[0-9]' package.json` | no matches |
| `grep '0\.8[0-9]\.[0-9]' package-lock.json` | 0 matches |

Test count grew 976 → 979: +1 budget-guard, +2 `session_compact_failed`. No test was deleted
or weakened at any point.

### Possible follow-up (not part of this goal)

During live-session execution the model was offered `create_goal` alongside the execution
tools (`create_goal, get_goal, update_goal, set_goal_tasks`). `create_goal` is documented as
a drafting-time tool that "is not a shortcut" — direct calls are rejected during guided
drafting. Exposing it during execution looks intentional rather than broken, and it behaved
correctly in the live run, so this goal changed nothing. It is flagged for a maintainer to
confirm whether the execution profile should include it.
