# pi-goal-x Maintainer-Owned Implementation, Pull-Request Replacement, Issue Resolution, Token-Efficiency, and Merge Plan

**Repository:** `tmonk/pi-goal-x`  
**Plan date:** 2026-08-23  
**Verified starting branch:** `main` at `a2b6568b615c639c76a1924ec2731e9a933876ce`  
**Current package version:** `0.27.4`  
**Scope:** open pull requests #27 and #29; open issues #30 and #26; the complete model-context and token journey; tests, benchmarks, rollout, release, merge, issue closure, and rollback.

---

## 1. Executive decision

All four open items are actionable, but none should be merged by accepting the existing contributor commits.

| Item | Decision | Delivery vehicle |
|---|---|---|
| PR #27 — global settings | Implement, but replace the branch history with a maintainer-owned clean-room implementation that fixes layering, inheritance, diagnostics, path resolution, concurrency, atomic writes, and UI semantics. | Rewrite and merge PR #27 when branch access permits; otherwise close it and merge a maintainer replacement PR. |
| PR #29 — hide unfocused banner | Implement after #27, as a layered setting with immediate UI refresh and no change to the model-facing focus safety rule. | Rewrite and merge PR #29 when branch access permits; otherwise close it and merge a maintainer replacement PR. |
| Issue #30 — repeated full checkpoint prompts | Confirmed high-severity defect. Fix first. New checkpoints become tiny trigger records; normal model context retains at most one checkpoint; existing oversized sessions receive a safe offline recovery tool. | New maintainer PR dedicated to issue #30. |
| Issue #26 — stronger-model Oracle before blocking | Worth adding as an opt-in feature. It must be read-only, bounded, explicitly configured, idempotent per blocker fingerprint, and integrated into the existing `update_goal({status:"blocked"})` path. | New maintainer PR dedicated to issue #26, after the settings foundation and context instrumentation. |

The token work is broader than issue #30. It will be delivered through separate measurement and optimization PRs so that each semantic change has an attributable outcome-quality gate and can be reverted independently.

---

## 2. Definition of done

The program is complete only when all of the following are true:

1. No commit authored or committed by the original PR submitters is an ancestor of any merged implementation branch.
2. No contributor commit is cherry-picked, rebased, squashed, or copied through a patch application.
3. PR #27 and PR #29 are either:
   - force-replaced with maintainer-owned histories and merged under their existing PR numbers; or
   - closed unmerged and superseded by maintainer-owned replacement PRs when GitHub permissions make same-PR history replacement impossible.
4. Issue #30 has a dedicated merged PR that:
   - eliminates full prompt persistence from continuation checkpoints;
   - keeps provider-visible checkpoint history bounded to one tiny marker;
   - provides detection and safe repair for existing oversized session files;
   - closes issue #30 with measured before/after evidence.
5. PR #27 has a dedicated merged implementation with correct global/project/env layering, per-leaf provenance, inheritance controls, atomic conflict-safe writes, and malformed-file diagnostics.
6. PR #29 has a dedicated merged implementation with live hide/restore behavior, global/project false overrides, and unchanged model-facing focus safety.
7. The complete model-context journey is measured, including tool schemas and the composed request rather than isolated prompt functions.
8. Remaining duplicate model payloads are removed only after a paired non-inferiority evaluation shows no outcome regression.
9. Issue #26 has a dedicated merged Oracle PR with:
   - explicit user configuration;
   - no silent model fallback;
   - read-only tools;
   - one successful consultation per blocker fingerprint;
   - bounded retries and output;
   - correct active/blocked lifecycle behavior;
   - durable ledger evidence.
10. Every PR passes the full local and GitHub validation gate.
11. Every merge uses an expected head SHA to prevent a last-moment head change.
12. Each merged behavior has a spec directory with `PRODUCT.md`, `TECH.md`, and `MILESTONES.md`.
13. Release notes, README configuration, package metadata, and recovery documentation match shipped behavior.
14. Post-merge smoke tests pass on `main`.
15. The relevant PR or issue is closed only after the merge SHA and validation evidence are posted.

---

## 3. Non-negotiable engineering rules

### 3.1 Maintainer-owned implementation only

The original PR diffs may be read as problem reports and design input. They must not be used as a source of commits or patches.

Forbidden:

```text
git cherry-pick <submitter-commit>
git rebase --onto ... <submitter-history>
git am contributor.patch
git apply pull-request.diff
git merge contributor-branch
GitHub squash-merge of the existing contributor history
Co-authored-by trailers naming the original submitter
```

Allowed:

```text
Read the issue/PR description.
Read current main.
Write a new spec.
Implement independently on a branch whose first parent is current main.
Push that maintainer history to the existing PR head only when authorized.
```

### 3.2 Separate PRs for separate concerns

The issue fixes must not be hidden inside PR #27 or #29.

Required separation:

1. Issue #30 checkpoint growth.
2. PR #27 global settings.
3. PR #29 banner suppression.
4. Model-context measurement.
5. Prompt/context single-source optimization.
6. UI/model payload separation.
7. Issue #26 blocker Oracle.
8. Release PRs as needed.

### 3.3 No correctness-for-token trade

A token-saving commit is rejected when it removes or weakens any of these:

- the complete user objective;
- current task identity;
- current task verification contract;
- goal verification contract;
- pending-task completion gate;
- Sisyphus order and no-improvisation policy;
- stale-checkpoint work prohibition;
- repeated-blocker policy;
- budget-stop behavior;
- unresolved auditor rejection findings;
- user ownership of focus, clear, pause, resume, and objective changes;
- auditor and Oracle read-only restrictions.

### 3.4 No destructive active-session rewriting

The extension must never rewrite the currently open Pi session JSONL behind Pi’s in-memory `SessionManager`. Existing-session repair is an offline operation with:

- dry-run default;
- explicit input path;
- timestamped backup;
- unchanged entry IDs and parent links;
- same-directory temporary file;
- atomic rename;
- post-write validation;
- clear instruction to close Pi before `--apply`.

### 3.5 No silent model selection

The auditor and Oracle may use the current session model only when the setting explicitly means “current/default.” Provider-only or ambiguous configuration is rejected. The Oracle feature, in particular, is enabled only when a complete, resolvable provider/model pair is configured.

---

## 4. Verified starting state and implications

### 4.1 Open PR heads

```text
PR #27
  base: tmonk/pi-goal-x main
  base SHA: a2b6568b615c639c76a1924ec2731e9a933876ce
  head repo: CarmeloCampos/pi-goal-x
  head ref: feat/config-global
  old head SHA: ea2251b4d7b9b3bc84bb5b29df65794c1456c447

PR #29
  base: tmonk/pi-goal-x main
  base SHA: a2b6568b615c639c76a1924ec2731e9a933876ce
  head repo: eettoreee/pi-goal-x
  head ref: feat/hide-unfocused-banner
  old head SHA: d2166d4acf0a61f6e64e272ecf23662cef7ca3ba
```

Both PRs originate from contributor forks. A pull request’s head repository and head ref cannot be retargeted to an arbitrary maintainer branch. Therefore, preserving the existing PR number while excluding contributor commits requires force-replacing the fork branch history. When the base maintainer lacks permission to push to the contributor fork, the two requirements “same PR number” and “no contributor commits” cannot both be satisfied; the only correct fallback is a maintainer replacement PR.

### 4.2 Issue #30 is not just an ordinary prompt-size issue

The current continuation path persists a full `continuationPrompt()` as a custom message on each progress turn. The reported session contained 851 checkpoint messages, 850 byte-identical, totaling roughly 5.4 MB.

Pi’s normal provider request path runs extension `context` transformations. Pi’s compaction preparation does not: it builds messages directly from raw session entries and serializes user/custom messages without a per-message cap. Consequently:

- filtering legacy messages in the extension `context` hook protects normal provider calls;
- it does not shrink the raw input Pi gives its compaction summarizer;
- a safe offline rewrite is required for already-stuck sessions;
- future checkpoint records must be intrinsically small.

### 4.3 The current token benchmark is incomplete

The existing B4 benchmark measures these strings separately:

- `taskListBlock`;
- `continuationPrompt`;
- `goalPrompt`.

It does not measure:

- the complete request after `before_agent_start`;
- the checkpoint message and system append together;
- active tool schemas;
- prior custom messages;
- audit progress tool schemas and calls;
- rich tool-result payloads;
- compaction input.

A measurement-only PR must establish the composed baseline before the lower-confidence optimizations merge.

---

## 5. Delivery graph and merge order

```text
Repository preflight / branch protection
          |
          v
PR A — issue #30 checkpoint growth + legacy recovery
          |
          +--> patch release 0.27.5
          |
          v
PR B — clean rewrite of PR #27 global settings
          |
          v
PR C — clean rewrite of PR #29 unfocused-banner setting
          |
          +--> minor release 0.28.0
          |
          v
PR D — complete model-context measurement and journey harness
          |
          v
PR E — single-source active-goal prompt and tool-result deduplication
          |
          v
PR F — UI/model payload separation and auditor prompt/progress cleanup
          |
          v
PR G — issue #26 blocker Oracle
          |
          +--> minor release 0.29.0
```

PR A is first because it addresses a confirmed session-breaking growth defect and has little overlap with settings work. PR G is last because the Oracle adds another nested model journey and should be built only after settings inheritance and model-context measurement are trustworthy.

---

## 6. Repository preflight

### 6.1 Freeze and snapshot

Before creating any implementation branch:

```bash
git clone git@github.com:tmonk/pi-goal-x.git
cd pi-goal-x

git fetch --all --prune
git switch main
git reset --hard origin/main

BASE_SHA="$(git rev-parse HEAD)"
test "$BASE_SHA" = "a2b6568b615c639c76a1924ec2731e9a933876ce"

git tag -a pre-maintenance-2026-08-23 "$BASE_SHA" \
  -m "Safety tag before PR rewrites and issue resolution"
git push origin pre-maintenance-2026-08-23
```

Re-read `origin/main` immediately before each PR. The recorded SHA above is the verified planning baseline, not permission to ignore a later main update.

### 6.2 Enable repository merge protection

`main` is currently unprotected. Configure:

- pull request required before merge;
- required status check: `validate`;
- branch must be up to date before merge;
- unresolved review conversations block merge;
- force pushes disabled;
- branch deletion disabled;
- administrator enforcement enabled;
- direct pushes disabled except emergency repository administration;
- merge queue optional; not required for this sequence.

Do not switch the CI workflow to `pull_request_target` for fork code. That event can expose base-repository credentials to untrusted code. Fork workflow approval remains manual until a maintainer-owned head is verified.

### 6.3 Establish the baseline

```bash
npm ci
npm run check
npm run lint
npm run test:all
npm run test:selfcheck
npm run test:serial
npm pack --dry-run
npm audit --omit=dev
npm run bench:gate:naf
```

Also capture:

```bash
npm run bench:naf -- after
cp experiments/bench/baseline-after.json \
   /tmp/pi-goal-x-baseline-main-a2b6568.json
```

Store command output in the first spec’s `MILESTONES.md`.

### 6.4 Add a reusable merge-check script

Add a repository script during PR A:

```text
scripts/verify-pr-head.mjs
```

Pseudo-code:

```ts
interface VerifyHeadOptions {
  baseRef: string;
  forbiddenAncestorShas: string[];
  forbiddenAuthorPatterns: RegExp[];
  requireCleanWorktree: boolean;
}

function verifyHead(opts: VerifyHeadOptions): void {
  assert(exec("git status --porcelain") === "");

  const commits = lines(exec(`git rev-list --reverse ${opts.baseRef}..HEAD`));
  assert(commits.length > 0);

  for (const sha of opts.forbiddenAncestorShas) {
    const isAncestor = exitCode(`git merge-base --is-ancestor ${sha} HEAD`) === 0;
    assert(!isAncestor, `Forbidden contributor head is an ancestor: ${sha}`);
  }

  for (const commit of commits) {
    const metadata = exec(
      `git show -s --format=%H%n%an%n%ae%n%cn%n%ce%n%B ${commit}`
    );

    for (const pattern of opts.forbiddenAuthorPatterns) {
      assert(!pattern.test(metadata));
    }

    assert(!/^Co-authored-by:/im.test(metadata));
  }
}
```

This is a provenance gate, not an authorship claim about individual ideas. It proves that the merged Git history contains only the new maintainer implementation.

---

## 7. Pull-request history replacement procedure

Apply this procedure independently to #27 and #29.

### 7.1 Record the original state

```bash
git remote add pr27 git@github.com:CarmeloCampos/pi-goal-x.git
git fetch pr27 feat/config-global

OLD_HEAD="$(git rev-parse pr27/feat/config-global)"
test "$OLD_HEAD" = "ea2251b4d7b9b3bc84bb5b29df65794c1456c447"
```

Post a PR conversation comment before rewriting:

```text
Maintainer implementation notice

The feature will be reimplemented from the current tmonk/pi-goal-x main
without cherry-picking, merging, patch-applying, or retaining commits from
the existing head. The current head is recorded as <OLD_HEAD> for audit.
When fork-branch permissions permit, the PR branch history will be replaced
with maintainer-owned commits and this PR will remain the review vehicle.
```

### 7.2 Implement from clean main

```bash
git fetch origin main
git switch --create maint/pr-27-global-settings origin/main

# Write spec, implementation, tests, and documentation independently.
# Do not inspect/apply the contributor patch while coding.
```

### 7.3 Verify provenance before updating the PR

```bash
node scripts/verify-pr-head.mjs \
  --base origin/main \
  --forbid-ancestor ea2251b4d7b9b3bc84bb5b29df65794c1456c447 \
  --forbid-author 'CarmeloCampos'
```

Manual confirmation:

```bash
git log --format='%H  %an <%ae>  %cn <%ce>' origin/main..HEAD
git merge-base --is-ancestor \
  ea2251b4d7b9b3bc84bb5b29df65794c1456c447 HEAD
# Expected exit code: 1
```

### 7.4 Replace the fork branch only with a lease

```bash
git push \
  --force-with-lease=refs/heads/feat/config-global:$OLD_HEAD \
  pr27 HEAD:refs/heads/feat/config-global
```

Never use an unconditional `--force`. A lease failure means the contributor pushed after the snapshot. Stop, record the new head, and reassess rather than overwriting it.

### 7.5 Hard fallback when fork writes are unavailable

When GitHub refuses the push:

1. Push the clean branch to `tmonk/pi-goal-x`.
2. Open a maintainer PR titled `feat(settings): layered global settings (supersedes #27)`.
3. Link #27.
4. Post the provenance verification.
5. Close #27 unmerged after the replacement PR is open.
6. Do not mark #27 merged and do not squash it.
7. Merge only the maintainer replacement PR.

The same procedure applies to #29 with its own old head SHA.

---

# PR A — Resolve issue #30: bounded continuation checkpoints and existing-session recovery

## 8. Product contract

### 8.1 Shipped behavior

For every active auto-continue goal:

- Pi still receives a hidden follow-up that triggers the next turn.
- The persisted follow-up contains only a small structured checkpoint marker.
- The full authoritative goal state is injected once by `before_agent_start`.
- Normal provider context contains at most one checkpoint marker.
- Historical checkpoint messages are removed from normal provider context by the `context` hook.
- Stale-checkpoint protections remain effective.
- Existing v1/full checkpoint messages remain parseable.
- Existing oversized session files can be repaired offline without losing entries or tree links.

### 8.2 Complexity targets

For `N` unchanged continuation turns:

```text
Before:
  persisted checkpoint content = O(N × fullGoalPromptBytes)
  provider-visible checkpoint history = O(N)
  compaction input = O(N × fullGoalPromptBytes)

After:
  persisted checkpoint content = O(N × <=160 bytes)
  provider-visible checkpoint history = O(1 checkpoint)
  future compaction input = O(N × <=160 bytes)
  repaired legacy compaction input = O(N × <=160 bytes)
```

A persisted trigger per turn remains necessary because Pi currently uses the delivered message to trigger a turn. The fix therefore makes provider-visible state O(1) and raw persistence bounded per turn; it does not pretend the session file can have zero entries per continuation.

## 9. Spec directory

```text
specs/2026-08-23-checkpoint-context-growth/
  PRODUCT.md
  TECH.md
  MILESTONES.md
```

`PRODUCT.md` defines user-visible behavior and recovery.  
`TECH.md` defines v2 checkpoint data, filtering, legacy compatibility, and benchmarks.  
`MILESTONES.md` records the reproducer, implementation commits, test outputs, and measured reductions.

## 10. Checkpoint v2 data model

In `extensions/goal-record.ts`:

```ts
export interface GoalCheckpointDetailsV2 {
  version: 2;
  kind: "checkpoint";
  goalId: string;
  status: "active";
  revision: number;
  checkpointSeq: number;
  timestamp: number;
}

export type GoalEventDetails =
  | GoalCheckpointDetailsV2
  | LegacyGoalEventDetails
  | GoalStaleDetails;
```

Do not persist `objective`, task text, contracts, budget strings, or policy text in v2 checkpoint details.

In `extensions/prompts/goal-prompts.ts`:

```ts
export const CHECKPOINT_TRIGGER_MAX_CHARS = 160;

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function checkpointTriggerPrompt(goalId: string): string {
  const content =
    `<pi_goal_continuation ` +
    `goal_id="${escapeXmlAttribute(goalId)}" ` +
    `kind="checkpoint" v="2"/>`;

  assert(content.length <= CHECKPOINT_TRIGGER_MAX_CHARS);
  return content;
}
```

Keep legacy extraction:

```ts
export function extractGoalIdFromInjectedMessage(text: string): string | null {
  return (
    matchV2SelfClosingContinuation(text) ??
    matchLegacyContinuation(text) ??
    matchLegacyBracketCheckpoint(text)
  );
}
```

The old `continuationPrompt()` export should not silently remain a full builder. Choose one of these explicit migrations:

```ts
/** @deprecated Use checkpointTriggerPrompt. */
export function continuationPrompt(goal: GoalRecord): string {
  return checkpointTriggerPrompt(goal.id);
}
```

or remove the export after all internal and test call sites are migrated. The preferred approach is a deprecated compatibility wrapper for one minor release.

## 11. Runtime scheduling change

In `extensions/goal-runtime.ts`:

```ts
export class GoalRuntime {
  private checkpointSeq = 0;

  private sendQueuedContinuation(
    ctx: ExtensionContext,
    scheduledGoalId: string,
  ): void {
    clearScheduledMarker();

    if (!this.hooks.isActionable(scheduledGoalId)) {
      clearQueuedMarkerFor(scheduledGoalId);
      return;
    }

    if (!safeIsReady(ctx)) {
      reschedule(scheduledGoalId);
      return;
    }

    const goal = this.hooks.getGoal();
    if (!goal || goal.id !== scheduledGoalId) {
      clearQueuedMarkerFor(scheduledGoalId);
      return;
    }

    this.checkpointSeq += 1;
    this.continuationQueuedFor = goal.id;

    this.hooks.sendFollowUp(
      checkpointTriggerPrompt(goal.id),
      {
        version: 2,
        kind: "checkpoint",
        goalId: goal.id,
        status: "active",
        revision: goal.revision,
        checkpointSeq: this.checkpointSeq,
        timestamp: Date.now(),
      } satisfies GoalCheckpointDetailsV2,
    );
  }
}
```

Consequences:

- remove `loadGoalSettings()` from `GoalRuntime`;
- remove full prompt construction from scheduling;
- retain scheduling, idle polling, deduplication, and stale-goal checks;
- do not change the `triggerTurn` and `deliverAs:"followUp"` behavior.

## 12. Normal model-context compaction

Replace the current map-and-rewrite behavior in `extensions/goal-events.ts` with a pure filter/normalize helper.

```ts
export function compactGoalCheckpointContext(
  messages: AgentMessage[],
  currentGoal: GoalRecord | null,
): AgentMessage[] {
  let lastCheckpointIndex = -1;

  for (let i = 0; i < messages.length; i += 1) {
    if (goalEventMessageId(messages[i]) !== null) {
      lastCheckpointIndex = i;
    }
  }

  if (lastCheckpointIndex < 0) return messages;

  const output: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const checkpointGoalId = goalEventMessageId(message);

    if (checkpointGoalId === null) {
      output.push(message);
      continue;
    }

    // Every historical checkpoint is redundant. Its authoritative state is
    // reconstructed from goal storage and injected by before_agent_start.
    if (i !== lastCheckpointIndex) continue;

    output.push({
      ...message,
      content: checkpointTriggerPrompt(checkpointGoalId),
      display: false,
      details: {
        version: 2,
        kind: currentGoal?.id === checkpointGoalId ? "checkpoint" : "stale",
        goalId: checkpointGoalId,
        currentGoalId: currentGoal?.id ?? null,
        currentStatus: currentGoal?.status ?? null,
      },
    });
  }

  return output;
}
```

The handler becomes:

```ts
pi.on("context", async (event) => {
  const messages = compactGoalCheckpointContext(
    event.messages,
    core.state.goal,
  );

  return messages === event.messages ? undefined : { messages };
});
```

Use an explicit `changed` flag rather than reference equality when the helper always allocates.

### Why one marker remains

Keeping the latest tiny marker avoids provider-specific edge cases where removing the user-like turn-start message leaves the request ending on an assistant or tool result. The full state is still supplied once through the system prompt.

## 13. Single authoritative full prompt

`before_agent_start` remains the sole full-state injection point:

```ts
const activeGoal = core.state.goal;
const settings = loadGoalSettings(ctx.cwd);
let prompt = goalPrompt(activeGoal, settings);

// Add only state-dependent deltas here:
prompt = appendStallDelta(prompt);
prompt = appendLatestAuditorRejection(prompt);
prompt = appendPostCompactionDelta(prompt);

return {
  systemPrompt: `${currentSystemPrompt()}\n\n${prompt}`,
};
```

Add a test that builds the composed request and asserts:

```ts
assert.equal(countOccurrences(request, activeGoal.objective), 1);
assert.equal(countOccurrences(request, activeGoal.verificationContract), 1);
assert.equal(countFullGoalBlocks(request), 1);
assert.equal(countCheckpointMarkers(request), 1);
```

## 14. Legacy session diagnostics

Add `extensions/goal-session-health.ts`:

```ts
export interface CheckpointHealth {
  total: number;
  legacyFull: number;
  v2Minimal: number;
  totalContentChars: number;
  recoverableChars: number;
  largestCheckpointChars: number;
}

export function inspectCheckpointHealth(
  entries: readonly SessionEntry[],
): CheckpointHealth {
  // Count only custom_message entries with GOAL_EVENT_ENTRY.
  // Classify v2 by details.version === 2 and bounded marker shape.
  // Treat any larger legacy content as recoverable.
}
```

Surface it in `/goal-status health` and `/goal-recovery` read-only reports:

```text
Session checkpoints:
  total: 851
  legacy full checkpoints: 851
  checkpoint content: 5.4 MB
  projected content after recovery: 92 KB
  close Pi, then run:
    pi-goal-x-recover --session <path> --dry-run
```

Never modify the active session from the command.

## 15. Shipped offline recovery CLI

Add:

```text
scripts/recover-session-checkpoints.mjs
```

Add to `package.json`:

```json
{
  "bin": {
    "pi-goal-x-recover": "scripts/recover-session-checkpoints.mjs"
  },
  "files": [
    "extensions",
    "scripts/recover-session-checkpoints.mjs",
    "README.md",
    "LICENSE",
    "docs/..."
  ]
}
```

### CLI contract

```text
pi-goal-x-recover --session <session.jsonl> [--dry-run]
pi-goal-x-recover --session <session.jsonl> --apply --confirm-pi-closed
```

Dry-run is the default. `--apply` without `--confirm-pi-closed` fails.

### Transformation pseudo-code

```ts
async function recoverSession(inputPath: string, apply: boolean): Promise<void> {
  const absolute = resolve(inputPath);
  const lstat = await fs.lstat(absolute);

  assert(lstat.isFile());
  assert(!lstat.isSymbolicLink());

  const original = await fs.readFile(absolute, "utf8");
  const originalMode = lstat.mode;

  const outputLines: string[] = [];
  const originalGraph: Array<{ id?: string; parentId?: string | null }> = [];
  const outputGraph: Array<{ id?: string; parentId?: string | null }> = [];

  let changed = 0;
  let savedChars = 0;
  let malformed = 0;

  for (const rawLine of splitPreservingFinalNewline(original)) {
    if (!rawLine.trim()) {
      outputLines.push(rawLine);
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      malformed += 1;
      outputLines.push(rawLine); // Never discard unrelated malformed data.
      continue;
    }

    originalGraph.push(graphIdentity(entry));

    if (!isGoalCheckpointCustomMessage(entry)) {
      outputLines.push(rawLine); // Byte-identical for untouched entries.
      outputGraph.push(graphIdentity(entry));
      continue;
    }

    const goalId = checkpointGoalId(entry);
    if (!goalId) {
      outputLines.push(rawLine);
      outputGraph.push(graphIdentity(entry));
      continue;
    }

    const rewritten = {
      ...entry,
      content: checkpointTriggerPrompt(goalId),
      details: {
        ...safeCheckpointMetadata(entry.details),
        version: 2,
        kind: "checkpoint",
        goalId,
      },
    };

    delete rewritten.details.objective;

    const rewrittenLine = JSON.stringify(rewritten);
    outputLines.push(rewrittenLine);
    outputGraph.push(graphIdentity(rewritten));

    changed += 1;
    savedChars += rawLine.length - rewrittenLine.length;
  }

  assertDeepEqual(outputGraph, originalGraph);
  validateEveryParentIdExists(outputLines);
  validateSessionHeaderUnchanged(original, outputLines);
  validateNonGoalLinesUnchanged(original, outputLines);

  printReport({ changed, savedChars, malformed });

  if (!apply) return;

  const backup = `${absolute}.backup-${timestamp()}`;
  await copyFileExclusive(absolute, backup, originalMode);

  const temp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`,
  );

  await writeFsyncClose(temp, joinLines(outputLines), originalMode);
  await fs.rename(temp, absolute);
  await fsyncDirectory(path.dirname(absolute));

  const reread = await fs.readFile(absolute, "utf8");
  validateRecoveredFile(reread, originalGraph);

  print(`Backup: ${backup}`);
}
```

### Recovery acceptance criteria

- line count unchanged;
- every entry `id` unchanged;
- every `parentId` unchanged;
- session header unchanged;
- non-goal lines byte-identical;
- malformed lines preserved byte-identically;
- only checkpoint `content` and checkpoint `details` change;
- recovery is idempotent;
- a second dry-run reports zero changes;
- file mode preserved;
- backup created before replacement;
- temp file removed on failure.

## 16. Tests for issue #30

Add or expand:

```text
tests/goal-accounting-runtime.test.ts
tests/goal-prompts.test.ts
tests/goal-stale-continuation-golden.test.ts
tests/session-state-growth.test.ts
tests/goal-session-health.test.ts
tests/session-checkpoint-recovery.test.ts
tests/integration/extension.test.ts
```

Required tests:

1. A scheduled continuation sends a v2 marker, not objective/task text.
2. Marker length is bounded.
3. Details omit objective and contracts.
4. `before_agent_start` injects one full goal block.
5. 1,000 unchanged turns persist no full goal prompt in checkpoints.
6. Provider context contains at most one checkpoint marker.
7. Legacy full checkpoints are removed from normal provider context.
8. Legacy latest checkpoint still triggers stale-checkpoint validation.
9. A checkpoint for a paused, cleared, complete, or replaced goal cannot call work tools.
10. Context filtering leaves audit events, user messages, assistant messages, and tool results untouched.
11. Recovery dry-run changes no file.
12. Recovery apply makes a backup.
13. Recovery preserves graph identities.
14. Recovery is idempotent.
15. Recovery handles malformed unrelated lines without dropping them.
16. Recovery refuses a symlink.
17. Recovery refuses apply without Pi-closed acknowledgement.
18. Windows and POSIX paths are accepted.
19. Test manifest is regenerated:

```bash
node scripts/run-unit-tests.mjs --write-manifest
npm run test:selfcheck
```

## 17. Benchmark additions for issue #30

Add `experiments/bench/b10-checkpoint-growth.mjs`.

Fixtures:

```text
turns: 1, 10, 100, 1,000
goal: unchanged 11-task tree
legacy checkpoint size: approximately 6.4K chars
v2 checkpoint size: measured exact
```

Rows:

```text
B10.checkpoint.persisted.1
B10.checkpoint.persisted.10
B10.checkpoint.persisted.100
B10.checkpoint.persisted.1000
B10.checkpoint.provider-context.1000
B10.checkpoint.recovery.850
B10.checkpoint.composed-request.50t
```

Gate:

```ts
assert(v2MarkerMaxChars <= 160);
assert(fullObjectiveOccurrencesInPersistedCheckpoints === 0);
assert(providerVisibleCheckpointCount <= 1);
assert(persistedCheckpointCharsAt1000 <= 160_000);
assert(recoveredChars <= legacyChars * 0.05);
assert(composedFullGoalBlocks === 1);
```

## 18. Issue #30 commit sequence

```text
docs(spec): define bounded checkpoint persistence and recovery
test(runtime): reproduce repeated full checkpoint growth
fix(runtime): emit minimal v2 continuation checkpoints
fix(context): retain only the latest minimal checkpoint
feat(recovery): add checkpoint health report and offline session repair
bench(context): gate checkpoint growth and composed prompt duplication
docs(recovery): document repair, compatibility, and rollback
chore(release): 0.27.5
```

## 19. Issue #30 merge and closure

Before merge:

```bash
git fetch origin main
git rebase origin/main
npm ci
npm run check
npm run lint
npm run test:all
npm run test:selfcheck
npm run test:serial
npm pack --dry-run
npm audit --omit=dev
npm run bench:gate:naf
node scripts/verify-pr-head.mjs --base origin/main
```

Merge with the exact reviewed head SHA. Post the following to issue #30 after `main` CI passes:

```text
Resolved in <merge-sha>.

Measured behavior:
- full checkpoint prompt copies persisted per turn: 1 -> 0
- provider-visible historical checkpoints: N -> <=1
- maximum v2 checkpoint content: <measured> chars
- 1,000-turn checkpoint content: <measured> chars
- 850-entry recovery reduction: <before> -> <after>
- full validation: <commands and counts>

Existing affected sessions can be repaired with the shipped dry-run-first
pi-goal-x-recover command after Pi is closed.
```

Close issue #30 as completed only after the post-merge workflow is green.

---

# PR B — Clean rewrite of PR #27: layered global settings

## 20. Product contract

Settings are resolved in this order:

```text
environment > project layer > global layer > defaults
```

Files:

```text
global:
  ${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-goal-x-settings.json

project:
  <cwd>/.pi/pi-goal-x-settings.json
```

Overrides:

```text
PI_GOAL_GLOBAL_SETTINGS_FILE
PI_GOAL_SETTINGS_FILE
existing per-setting PI_GOAL_* variables
```

Requirements:

- explicit `false` overrides inherited `true`;
- explicit `0` overrides inherited positive values;
- nested keybindings inherit per leaf;
- the menu displays the effective value and source;
- the menu can remove a local override and return to inheritance;
- malformed files are diagnosed by scope and path;
- valid known values continue to load when unrelated unknown keys are present;
- writes do not lose concurrent changes from another process;
- writes are atomic;
- file-cache behavior remains zero-op during steady state;
- `/goal-refresh` invalidates and re-reads both layers;
- no global file means behavior is identical to project-only behavior.

## 21. Spec directory

```text
specs/2026-08-23-layered-global-settings/
  PRODUCT.md
  TECH.md
  MILESTONES.md
```

## 22. Separate sparse storage from resolved settings

Do not use one interface for both file contents and effective runtime settings.

```ts
export interface GoalDashboardKeybindingsLayer {
  toggleExpand?: KeyId;
  scrollUp?: KeyId;
  scrollDown?: KeyId;
}

export interface GoalKeybindingsLayer {
  dashboard?: GoalDashboardKeybindingsLayer;
}

export interface GoalSettingsLayer {
  disableTasks?: boolean;
  disableContracts?: boolean;
  subtaskDepth?: number;

  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  disabled?: boolean;

  autoSelectSingleGoal?: boolean;
  auditorProjectResources?: boolean;
  stallTimeoutMinutes?: number;
  objectiveMaxChars?: number;

  keybindings?: GoalKeybindingsLayer;
}

export interface ResolvedGoalSettings {
  disableTasks: boolean;
  disableContracts: boolean;
  subtaskDepth: number;

  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  disabled: boolean;

  autoSelectSingleGoal: boolean;
  auditorProjectResources: boolean;
  stallTimeoutMinutes: number;
  objectiveMaxChars: number;

  keybindings: GoalKeybindings;
}
```

For internal compatibility, either rename all runtime uses to `ResolvedGoalSettings` or keep:

```ts
export type GoalSettings = ResolvedGoalSettings;
```

Do not pass `GoalSettingsLayer` to prompt/runtime code.

## 23. Parse result and diagnostics

```ts
export type SettingsDiagnosticCode =
  | "invalid_json"
  | "not_object"
  | "unknown_key"
  | "invalid_value"
  | "invalid_nested_key";

export interface SettingsDiagnostic {
  scope: "global" | "project";
  path: string;
  settingPath?: string;
  code: SettingsDiagnosticCode;
  message: string;
}

export interface SettingsLayerRead {
  scope: "global" | "project";
  path: string;
  status: "ok" | "missing" | "invalid";
  layer: GoalSettingsLayer;
  diagnostics: SettingsDiagnostic[];
  fingerprint: string;
}
```

Parsing pseudo-code:

```ts
function parseSettingsLayer(
  raw: unknown,
  scope: SettingsScope,
  path: string,
): { layer: GoalSettingsLayer; diagnostics: SettingsDiagnostic[] } {
  if (!isPlainObject(raw)) {
    return {
      layer: {},
      diagnostics: [diagnostic("not_object")],
    };
  }

  const layer: GoalSettingsLayer = {};
  const diagnostics: SettingsDiagnostic[] = [];

  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "disableTasks":
      case "disableContracts":
      case "disabled":
      case "autoSelectSingleGoal":
      case "auditorProjectResources":
        assignBooleanOrDiagnostic(layer, key, value, diagnostics);
        break;

      case "subtaskDepth":
        assignIntegerOrDiagnostic(layer, key, value, { min: 1 }, diagnostics);
        break;

      case "stallTimeoutMinutes":
      case "objectiveMaxChars":
        assignIntegerOrDiagnostic(layer, key, value, { min: 0 }, diagnostics);
        break;

      case "provider":
      case "model":
        assignNonEmptyStringOrDiagnostic(layer, key, value, diagnostics);
        break;

      case "thinkingLevel":
      case "thinking_level":
        assignThinkingLevelOrDiagnostic(layer, value, diagnostics);
        break;

      case "keybindings":
        layer.keybindings = parseSparseKeybindings(value, diagnostics);
        break;

      default:
        diagnostics.push(unknownKeyDiagnostic(key));
        break;
    }
  }

  return { layer, diagnostics };
}
```

Unknown keys are not applied. They are visible diagnostics. They do not silently erase every valid known setting in the same file.

## 24. Pure path resolution

Do not mix an injected `env` object with ambient `process.env`.

```ts
export interface SettingsPathInputs {
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

function resolveAgentDir(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  const override = nonEmpty(env.PI_CODING_AGENT_DIR);
  if (override) {
    return path.isAbsolute(override)
      ? path.normalize(override)
      : path.resolve(homeDir, override);
  }

  return path.join(homeDir, ".pi", "agent");
}

export function goalGlobalSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const fileOverride = nonEmpty(env.PI_GOAL_GLOBAL_SETTINGS_FILE);

  if (fileOverride) {
    return path.isAbsolute(fileOverride)
      ? path.normalize(fileOverride)
      : path.resolve(homeDir, fileOverride);
  }

  return path.join(
    resolveAgentDir(env, homeDir),
    "pi-goal-x-settings.json",
  );
}
```

Tests must pass isolated environment objects without mutating process globals.

## 25. Layer resolution and per-leaf provenance

```ts
export type SettingsSource =
  | "environment"
  | "project"
  | "global"
  | "default";

export interface ResolvedSetting<T> {
  value: T;
  source: SettingsSource;
  envVar?: string;
}

export interface SettingsSnapshot {
  global: SettingsLayerRead;
  project: SettingsLayerRead;
  value: ResolvedGoalSettings;
  provenance: Map<string, ResolvedSetting<unknown>>;
  diagnostics: SettingsDiagnostic[];
}
```

Resolver:

```ts
function resolveLeaf<T>(args: {
  envValue?: T;
  projectValue?: T;
  globalValue?: T;
  defaultValue: T;
  envVar?: string;
}): ResolvedSetting<T> {
  if (args.envValue !== undefined) {
    return {
      value: args.envValue,
      source: "environment",
      envVar: args.envVar,
    };
  }

  if (args.projectValue !== undefined) {
    return { value: args.projectValue, source: "project" };
  }

  if (args.globalValue !== undefined) {
    return { value: args.globalValue, source: "global" };
  }

  return { value: args.defaultValue, source: "default" };
}
```

Nested keybindings are resolved leaf by leaf:

```ts
const toggleExpand = resolveLeaf({
  projectValue: project.keybindings?.dashboard?.toggleExpand,
  globalValue: global.keybindings?.dashboard?.toggleExpand,
  defaultValue: DEFAULT_GOAL_KEYBINDINGS.dashboard.toggleExpand,
});
```

Never parse a sparse keybindings layer into a fully defaulted object before merging.

## 26. Cache model

```ts
interface SettingsCacheEntry {
  read: SettingsLayerRead;
}

const settingsCache = new Map<string, SettingsCacheEntry>();
```

Rules:

- first read per path parses the file;
- missing and invalid states are cached;
- extension writes invalidate only the affected path;
- `session_start` invalidates all settings paths;
- `/goal-refresh` captures the cache-served fingerprint, invalidates both layers, then reloads;
- the global and project fingerprints are reported separately;
- no per-widget stat/read is added.

## 27. Conflict-safe scoped mutation API

Do not save a cached whole settings object.

```ts
export type SettingsMutation =
  | {
      op: "set";
      path: readonly string[];
      value: unknown;
    }
  | {
      op: "unset";
      path: readonly string[];
    };

export interface MutateSettingsInput {
  scope: "global" | "project";
  cwd: string;
  env?: NodeJS.ProcessEnv;
  mutation: SettingsMutation;
}
```

Pseudo-code:

```ts
export function mutateSettingsLayer(
  input: MutateSettingsInput,
): SettingsSnapshot {
  const target = settingsPathForScope(input);
  const lock = acquirePathLock(`${target}.lock`, {
    attempts: 20,
    retryMs: 5,
    staleTtlMs: 30_000,
  });

  try {
    const current = readSettingsLayerFresh(target, input.scope);

    if (current.status === "invalid") {
      throw new SettingsMutationError(
        `Refusing to overwrite invalid ${input.scope} settings at ${target}`,
        current.diagnostics,
      );
    }

    const next = structuredClone(current.layer);
    applyPathMutation(next, input.mutation);
    pruneEmptyObjects(next);

    const parsed = parseSettingsLayer(next, input.scope, target);
    if (hasInvalidValueDiagnostics(parsed.diagnostics)) {
      throw new SettingsMutationError("Mutation produced invalid settings");
    }

    atomicWriteJson(target, parsed.layer, {
      defaultMode: 0o600,
      preserveExistingMode: true,
    });

    settingsCache.delete(target);
    return loadSettingsSnapshot(input.cwd, input.env);
  } finally {
    lock.release();
  }
}
```

The lock must be a generic path lock or a settings-specific wrapper, not a fake in-memory mutex. Multiple Pi processes can edit the same global file.

## 28. Atomic write implementation

```ts
function atomicWriteJson(
  target: string,
  value: unknown,
  options: AtomicWriteOptions,
): void {
  const parent = path.dirname(target);
  ensureRealDirectory(parent);
  refuseSymlinkTarget(target);

  const existingMode = safeExistingMode(target);
  const mode = existingMode ?? options.defaultMode;
  const temp = path.join(
    parent,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );

  let fd: number | undefined;

  try {
    fd = fs.openSync(temp, "wx", mode);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    fs.renameSync(temp, target);
    fsyncDirectoryBestEffort(parent);
  } catch (error) {
    if (fd !== undefined) safeClose(fd);
    safeUnlink(temp);
    throw error;
  }
}
```

Tests must cover write failure before rename and verify that the original target remains parseable.

## 29. Settings UI semantics

Every row shows:

```text
<label>: <effective value> (<source>)
```

Examples:

```text
disableTasks: true (global)
disableTasks: false (project override; global is true)
objectiveMaxChars: 0 (inherited from global)
provider/model: anthropic/claude-opus-4-6 (environment; read-only)
```

Selecting a row opens an action menu, not an implicit toggle based on the selected file’s raw value.

Boolean row:

```text
Set project override to true
Set project override to false
Use inherited value
Cancel
```

Integer row:

```text
Set project override...
Use inherited value
Cancel
```

Model row at project scope:

```text
Inherit global model
Use current Pi session/default explicitly
Choose model...
Enter provider/model manually...
Cancel
```

Global scope has no “inherit global”; it has “use default” by deleting the global override.

Pseudo-code:

```ts
async function editRow(
  row: SettingRow,
  scope: SettingsScope,
  snapshot: SettingsSnapshot,
  ctx: ExtensionContext,
): Promise<void> {
  const localLayer = layerForScope(snapshot, scope);
  const localValue = getPath(localLayer.layer, row.path);
  const effective = snapshot.provenance.get(pathKey(row.path));

  const action = await selectAction({
    row,
    scope,
    localValue,
    effective,
  });

  switch (action.kind) {
    case "set":
      mutateSettingsLayer({
        scope,
        cwd: ctx.cwd,
        mutation: { op: "set", path: row.path, value: action.value },
      });
      break;

    case "inherit":
      mutateSettingsLayer({
        scope,
        cwd: ctx.cwd,
        mutation: { op: "unset", path: row.path },
      });
      break;

    case "cancel":
      return;
  }

  core.applyEffectiveSettings(ctx);
}
```

## 30. Central runtime side-effect hook

Add to `GoalCore`:

```ts
interface AppliedSettingsState {
  disableTasks: boolean;
  hideUnfocusedBanner: boolean; // added by PR C
  keybindings: GoalKeybindings;
}

function applyEffectiveSettings(ctx: ExtensionContext): void {
  const next = loadGoalSettings(ctx.cwd);

  if (next.disableTasks !== tasksEnabled) {
    installGoalToolProfile(!next.disableTasks);
  }

  goalWidgetComponentRef.current?.invalidate();
  updateUI(ctx);
}
```

PR B initially handles task-profile and settings diagnostics. PR C extends the same hook for banner behavior. Avoid ad hoc per-row runtime refresh code.

## 31. Global settings tests

Required cases:

- global path default;
- injected `PI_CODING_AGENT_DIR`;
- injected `PI_GOAL_GLOBAL_SETTINGS_FILE`;
- relative global override resolved from injected home;
- project path override;
- no global file;
- global-only setting;
- project-over-global;
- project false over global true;
- project zero over global positive;
- environment over both;
- nested keybinding leaf inheritance;
- project one-key keybinding override does not reset other global leaves;
- unknown key diagnostic while known values still apply;
- malformed global with valid project;
- valid global with malformed project;
- invalid layer cannot be overwritten without explicit repair;
- menu displays effective inherited value;
- first boolean action changes the effective value exactly once;
- unset restores inheritance;
- provider/model “inherit” differs from “Pi default”;
- two processes edit different keys without lost update;
- stale lock recovery;
- live lock contention fails clearly;
- failed temporary write preserves original;
- symlink target refused;
- zero-op cache remains zero-op in benchmark;
- `/goal-refresh` detects external changes to either layer;
- settings provenance is correct per leaf;
- headless settings reports both paths without writing.

## 32. PR #27 maintainer commit sequence

```text
docs(spec): define layered global goal settings
refactor(settings): separate sparse layers from resolved values
feat(settings): resolve global project and environment layers
fix(settings): add diagnostics and per-leaf provenance
fix(settings): make scoped mutations atomic and conflict-safe
feat(settings-ui): edit scopes and clear inherited overrides
test(settings): cover layering concurrency diagnostics and paths
docs(settings): document global and project configuration
```

Force-replace `CarmeloCampos:feat/config-global` only after all commits and gates pass. Run the forbidden-ancestor check against `ea2251b4...`.

## 33. PR #27 acceptance criteria

- every effective value has one source;
- inherited values display correctly;
- one user action changes a boolean to the selected value;
- every override can be removed from the UI;
- no lost update in a two-writer test;
- no partial JSON after fault injection;
- no unexpected file-system operations on the hot path;
- no contributor commit in history;
- full CI and serial SDK suite green.

---

# PR C — Clean rewrite of PR #29: hide unfocused banner

## 34. Product contract

Add a layered boolean:

```ts
GoalSettingsLayer.hideUnfocusedBanner?: boolean
ResolvedGoalSettings.hideUnfocusedBanner: boolean // default false
```

When all are true:

```text
ctx.hasUI
no focused goal
one or more open goals
hideUnfocusedBanner === true
```

the extension displays neither:

- the above-editor unfocused goal widget;
- the `goal: unfocused [N open] - /goal-focus` status hint.

This setting must not:

- hide a focused goal dashboard;
- hide audit UI;
- change open-goal storage;
- focus or unfocus a goal;
- change the model-facing `[PI GOAL UNFOCUSED]` safety prompt;
- suppress `/goal-list`, `/goal-focus`, `/goal-status`, or notifications explicitly requested by the user.

## 35. Spec directory

```text
specs/2026-08-23-unfocused-banner-setting/
  PRODUCT.md
  TECH.md
  MILESTONES.md
```

## 36. Render logic

```ts
function renderUI(ctx: ExtensionContext): void {
  const totalOpen = openGoals().length;

  if (!state.goal && totalOpen === 0) {
    clearGoalWidget(ctx);
    return;
  }

  if (!state.goal) {
    const settings = loadGoalSettings(ctx.cwd);

    if (settings.hideUnfocusedBanner) {
      clearGoalWidget(ctx); // Clears both status and widget.
      return;
    }

    renderUnfocusedWidgetAndStatus(ctx, totalOpen);
    return;
  }

  renderFocusedDashboard(ctx);
}
```

Extract `renderUnfocusedWidgetAndStatus()` so focused and unfocused factory logic is not interleaved.

## 37. Immediate live refresh

Every successful settings mutation already ends in:

```ts
core.applyEffectiveSettings(ctx);
```

That hook must call `updateUI(ctx)`. Because `updateUI` is microtask-coalesced, repeated calls are inexpensive.

Test the state before the command handler resolves:

```ts
await goalSettingsCommand(...select hide true...);

assert.equal(ui.status.get("goal"), undefined);
assert.equal(ui.widgets.get("goal"), undefined);
```

Do not rely on a later turn, focus event, or refresh command to make the setting visible.

## 38. Layering cases

Required behavior:

```text
global absent, project absent            -> visible
global true, project absent              -> hidden
global true, project false               -> visible
global false, project true               -> hidden
environment: no override exists          -> file/default resolution
focused goal, any value                  -> focused dashboard visible
no open goals, any value                 -> no unfocused banner
```

## 39. Model-facing safety invariant

Keep this behavior unchanged:

```ts
if (!core.state.goal && core.openGoals().length > 0) {
  return {
    systemPrompt:
      `${currentSystemPrompt()}\n\n` +
      unfocusedOpenGoalsPrompt(openCount),
  };
}
```

Add an explicit test:

```ts
assert.match(systemPrompt, /\[PI GOAL UNFOCUSED\]/);
assert.match(systemPrompt, /Do not choose or switch focus autonomously/);
```

## 40. PR #29 tests

- parse true/false boolean and string forms;
- global true/project false;
- save/unset round trip;
- settings provenance row;
- menu row and action controls;
- live hide;
- live restore;
- focused dashboard unaffected;
- no-goal/no-open state;
- headless path;
- model prompt unchanged;
- widget/status stale state fully cleared;
- repeated toggle does not double-register widget;
- no contributor commit in history.

## 41. PR #29 commit sequence

```text
docs(spec): define optional unfocused UI suppression
feat(settings): add layered hideUnfocusedBanner setting
refactor(ui): isolate unfocused goal rendering
feat(ui): hide and restore unfocused goal chrome live
test(ui): cover focus inheritance and live refresh
docs(ui): document hideUnfocusedBanner
```

Force-replace `eettoreee:feat/hide-unfocused-banner` only after rebasing on merged PR B. Run the forbidden-ancestor check against `d2166d4a...`.

---

# PR D — Complete model-context measurement and outcome harness

## 42. Purpose

This PR changes no shipped behavior. It creates the evidence needed to remove tokens without weakening outcomes.

## 43. Spec directory

```text
specs/2026-08-23-model-context-accounting/
  PRODUCT.md
  TECH.md
  MILESTONES.md
```

## 44. Capture the composed request

Add a test-only provider adapter that captures the request after:

- session context construction;
- extension `context` transformation;
- `before_agent_start`;
- system-prompt construction;
- active tool selection;
- tool-schema construction.

No network call is permitted.

```ts
export interface CapturedModelRequest {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  metadata: {
    fixture: string;
    goalId?: string;
  };
}
```

Pseudo-code:

```ts
async function captureOneTurn(fixture: Fixture): Promise<CapturedModelRequest> {
  const capture = deferred<CapturedModelRequest>();

  const fakeModelRuntime = createFakeModelRuntime({
    onRequest(request) {
      capture.resolve(normalizeRequest(request));
      return deterministicAssistantStop();
    },
  });

  const { session } = await createAgentSession({
    cwd: fixture.cwd,
    modelRuntime: fakeModelRuntime,
    sessionManager: fixture.sessionManager,
    resourceLoader: fixture.resourceLoader,
  });

  installGoalExtension(session, fixture.goal);
  await fixture.trigger(session);

  return capture.promise;
}
```

## 45. Measurement categories

```ts
export interface ContextSizeBreakdown {
  baseSystemChars: number;
  extensionSystemChars: number;
  checkpointChars: number;
  historicalCheckpointChars: number;
  goalStateChars: number;
  toolSchemaChars: number;
  messageChars: number;
  totalSerializedChars: number;
  estimatedTokens: number;
}
```

Count exact occurrences of semantic fields:

```ts
export interface SemanticOccurrenceCounts {
  objective: number;
  goalContract: number;
  currentTask: number;
  currentTaskContract: number;
  lifecyclePolicy: number;
  blockerPolicy: number;
  auditorRejection: number;
}
```

## 46. Fixtures

- active regular goal, no tasks;
- active regular goal, 10 tasks;
- active regular goal, 50 tasks;
- current contracted task;
- nested tasks;
- half-complete task tree;
- long objective;
- Sisyphus ordered objective;
- token budget at 0%, 75%, and limit;
- paused goal;
- blocked goal;
- unfocused multiple goals;
- latest auditor rejection;
- post-compaction turn;
- stale checkpoint;
- guided drafting question;
- guided proposal;
- completion audit;
- audit rejection and rework;
- `get_goal` default and verbose.

## 47. Baseline artifacts

```text
experiments/context/
  capture-context.mjs
  fixtures.mjs
  measure-context.mjs
  semantic-invariants.mjs
  baseline-main.json
  README.md

specs/2026-08-23-model-context-accounting/
  CONTEXT-BASELINE.md
```

No live provider is part of CI. Optional live-provider measurements are stored separately and must not contain prompts, secrets, or user content.

## 48. Measurement gate

Add:

```text
npm run context:measure
npm run context:gate
```

Initial gate:

- baseline can be reproduced within deterministic equality for exact fixtures;
- no network or child agent;
- every semantic field is classified;
- tool schemas are included;
- checkpoint history count is bounded after PR A;
- all fixture IDs are covered.

Later optimization PRs update the accepted baseline only with an explicit spec rationale.

## 49. Outcome journey harness

Add scripted repositories and artifact-based rubrics:

```text
experiments/context-eval/
  journeys/
  fixtures/
  rubrics/
  run-paired.mjs
  adjudicate.mjs
  README.md
```

Each journey has:

```ts
interface JourneyDefinition {
  id: string;
  seedRepo: string;
  initialGoal: GoalRecord;
  scriptedUserMessages: string[];
  success: ArtifactAssertion[];
  forbidden: BehaviorAssertion[];
}
```

Examples:

- regular one-step goal;
- 10-task goal;
- 50-task goal;
- contracted task;
- Sisyphus order;
- stale checkpoint;
- pause/resume;
- third repeated blocker;
- budget stop;
- multiple open goals;
- goal tweak;
- compaction resume;
- audit rejection and rework.

Deterministic fake-agent tests verify protocol mechanics. A paired live-agent suite verifies outcome quality before a token-saving PR merges.

---

# PR E — Single-source active-goal prompt and low-risk deduplication

## 50. Scope

This PR removes exact or near-exact duplicates while keeping all required semantic information.

## 51. Task block deduplication

Current task must not also appear as a generic pending item and “next pending” item.

```ts
function taskListBlock(goal: GoalRecord, settings: ResolvedGoalSettings): string {
  const current = findCurrentTask(goal);
  const visiblePending = pendingTasks(goal)
    .filter((task) => task.id !== current?.id)
    .slice(0, MAX_PENDING_RENDERED);

  const lines = [taskHeader(goal)];

  if (current) lines.push(renderCurrentTask(current));
  lines.push(...visiblePending.map(renderPendingTask));

  const firstUnrendered = firstPendingNotIn(current, visiblePending);
  if (firstUnrendered && visiblePending.length === 0) {
    lines.push(renderNextPending(firstUnrendered));
  }

  lines.push(renderHiddenPendingCountWithoutUiShortcut());
  lines.push(renderTaskGateWhenNeeded(goal));

  return lines.join("\n");
}
```

Model-facing text must not tell the model to press `Ctrl+Shift+T`. Replace:

```text
(+17 more pending — expand the dashboard with Ctrl+Shift+T)
```

with:

```text
17 additional pending tasks are omitted from this bounded prompt.
```

The human dashboard retains its shortcut.

## 52. Canonical lifecycle policy

Create one policy object:

```ts
interface GoalPolicyText {
  completion: string;
  blocked: string;
  pause: string;
  objectiveMutation: string;
  taskOperations: string;
  sisyphus?: string;
}

function renderLifecyclePolicy(goal: GoalRecord): string;
```

`goalPrompt`, tool guidelines, and continuation-specific text must not independently restate the same blocker rule. Runtime-enforced validation remains in code; prompt text states it once.

Semantic tests:

```ts
assert.equal(countRule(prompt, "third consecutive identical blocker"), 1);
assert.equal(countRule(prompt, "independent auditor"), 1);
assert.equal(countRule(prompt, "never edit objective"), 1);
```

## 53. Concise `get_goal` default

Add optional parameters:

```ts
parameters: Type.Object({
  verbose: Type.Optional(Type.Boolean()),
  include_history: Type.Optional(Type.Boolean()),
});
```

Default result:

```text
Goal <id>: <status>, <mode>
Objective: <full objective>
Current task: <id/title/contract>
Next pending: <id/title>
Tasks: N/M complete, K skipped
Budget: ...
Blocker or latest required auditor action: ...
```

Verbose retains paths, detailed pending tasks, history, and complete diagnostics.

Do not remove the full objective from `get_goal`; it is an explicit state-read tool. Remove duplicated task headings and repeated lifecycle prose.

## 54. Tool-schema prose consolidation

For every model tool:

- description: capability and hard lifecycle boundary;
- parameter description: field meaning;
- prompt snippet: one sentence;
- guidelines: only rules not already present in the canonical active-goal policy.

No rule should appear in all four places.

## 55. Feature flag for emergency comparison

For one minor release:

```text
PI_GOAL_PROMPT_PROFILE=compact-v2   # default
PI_GOAL_PROMPT_PROFILE=legacy-v1    # emergency/A-B fallback
```

Legacy mode must not restore full persisted continuation prompts. It may restore only the pre-optimization active system and tool-result wording.

## 56. PR E acceptance

- all required semantic markers present;
- each exact policy appears once;
- current task appears once;
- current task contract appears once;
- composed input reduced on every task fixture;
- no baseline-pass/candidate-fail journey;
- stale, pause, focus, budget, task gate, and audit behavior unchanged.

---

# PR F — Separate human display payloads from model payloads

## 57. Guided proposal flow

Remove the instruction requiring the model to write the entire proposal in prose before calling `propose_goal_draft`.

The model supplies the structured tool arguments once. The tool call renderer remains the scrollable complete human presentation. The durable result summary appears once after the decision.

```ts
const draftingProtocol = [
  "Clarify only material ambiguity.",
  "Call propose_goal_draft with the complete structured proposal.",
  "The tool renderer presents the complete objective and task tree.",
  "Do not duplicate the complete proposal in a preceding prose message.",
];
```

Test that the tool renderer contains every objective and task line.

## 58. Concise model result, rich human rendering

Create a pattern:

```ts
interface RichGoalToolDetails {
  goal: GoalRecord | null;
  resultDetail?: string;
  humanCard?: string;
}

return {
  content: [{
    type: "text",
    text: `Goal created and focused: ${goal.id}.`,
  }],
  details: {
    goal: cloneGoal(goal),
    humanCard: buildGoalCreatedReport(...),
  },
};
```

`renderGoalResult()` uses `humanCard`. The model receives the concise content. Apply this to:

- `create_goal`;
- confirmed draft;
- task-list confirmation;
- completion success;
- audit rejection;
- pause/block result where details already exist.

Do not hide failure reasons from the model.

## 59. Audit event separation

Audit-start and progress updates are display events, not new agent turns.

Replace:

```ts
pi.sendMessage(auditStartedMessage, { triggerTurn: true });
```

with a display-only path:

```ts
pi.sendMessage(auditStartedMessage, { triggerTurn: false });
```

or direct UI state where no durable transcript event is required.

The final verdict reaches the executor once through the `update_goal` tool result. A visible audit card may remain in the transcript but is filtered from model context when its information already exists in the tool result.

## 60. Remove the auditor progress model tool

Derive progress from nested-session events:

```ts
function progressFromAuditorEvent(event: AuditorSessionEvent): AuditorProgressDelta {
  switch (event.type) {
    case "agent_start":
      return { label: "Starting audit...", percentage: 0 };

    case "tool_execution_start":
      return {
        label: labelForReadOnlyTool(event.toolName),
        percentage: estimateAuditProgress(event.toolName),
      };

    case "message_update":
      if (containsFinalText(event)) {
        return { label: "Producing report...", percentage: 90 };
      }
      return {};

    case "agent_end":
      return { label: "Audit complete.", percentage: 100 };

    default:
      return {};
  }
}
```

Remove:

- `report_auditor_progress` tool registration;
- its schema;
- prompt snippet;
- prompt guidelines;
- duplicated progress protocol from system and user prompts;
- tool-result messages generated solely for progress.

The human widget continues receiving progress.

## 61. Auditor prompt single-source design

```ts
function buildGoalAuditorPrompt(args: AuditInput): string {
  return [
    auditorTaskAndVerdictContract(),      // role/decision once
    xmlBlock("objective", args.goal.objective),
    xmlBlock("executor_claim", args.completionSummary ?? "(none)"),
    xmlBlock("goal_metadata", minimalGoalMetadata(args.goal)),
    xmlBlock("task_state", renderTaskTreeOnce(args.goal.taskList)),
    xmlBlock("verification_contract", args.goal.verificationContract),
    xmlBlock("warm_evidence", args.warmContext),
    auditChecklistOnce(args),
  ].filter(Boolean).join("\n\n");
}
```

`minimalGoalMetadata()` must not contain the objective or task tree.

The isolated auditor system prompt contains only stable role and safety boundaries. The user prompt contains case-specific evidence and the final marker contract. Do not repeat the full verdict protocol in both.

## 62. Post-compaction delta

Replace the full duplicate goal summary with a delta:

```ts
function buildPostCompactionGoalDelta(args): string {
  return [
    `[POST-COMPACTION RESYNC goalId=${args.goal.id}]`,
    renderCurrentTaskAndContract(args.goal),
    renderRecentUsefulEvents(args.events, 5),
    renderLatestUnresolvedAuditFinding(args.events),
    `Other open goals: ${args.otherOpenCount}`,
    "Continue from authoritative files and goal storage.",
  ].filter(Boolean).join("\n");
}
```

The active system goal block already contains the objective, full policy, task gate, and goal contract.

Cap terminal-goal lists and long event details.

## 63. PR F acceptance

- proposal remains fully visible to the user;
- no full proposal prose duplicate is required;
- model-facing create result is concise;
- audit progress UI remains functionally equivalent;
- no progress-report model tool or calls;
- objective appears once in auditor request;
- task tree appears once;
- audit verdict reaches executor once;
- compaction resumes with all actionable state;
- paired journeys show no degradation.

---

# PR G — Resolve issue #26: opt-in blocker Oracle

## 64. Product decision

Issue #26 is a valid feature request. A cheap executor can benefit from one stronger, read-only consultation before it gives up and asks the user. The feature is not safe as an automatic unrestricted subagent loop. It must be:

- disabled by default;
- explicitly configured with a provider and model;
- invoked only through a valid blocked request;
- read-only;
- bounded by blocker fingerprint;
- durable and auditable;
- unable to mutate goal state directly;
- unable to approve completion;
- unable to choose focus;
- unable to loop indefinitely.

## 65. Spec directory

```text
specs/2026-08-23-blocker-oracle/
  PRODUCT.md
  TECH.md
  MILESTONES.md
```

## 66. Settings schema

Add a sparse nested layer:

```ts
export interface OracleSettingsLayer {
  enabled?: boolean;
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  projectResources?: boolean;
  maxFailedAttemptsPerBlocker?: number;
}

export interface GoalSettingsLayer {
  // existing keys...
  oracle?: OracleSettingsLayer;
}

export interface ResolvedOracleSettings {
  enabled: boolean;                    // default false
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  projectResources: boolean;           // default false
  maxFailedAttemptsPerBlocker: number; // default 2, max 3
}
```

Per-leaf global/project inheritance comes from PR B.

The settings menu gets a `Blocker Oracle` section:

```text
Oracle enabled
Oracle provider/model
Oracle thinking level
Oracle project resources
Maximum failed attempts per blocker
```

When enabled without a resolvable explicit provider/model, display a configuration error and do not silently use the executor model.

## 67. Extend `update_goal` input

```ts
parameters: Type.Object({
  status: StringEnum(["complete", "blocked", "paused"]),

  reason: Type.Optional(Type.String({
    maxLength: 1000,
    description:
      "Required for blocked and paused. Describe the concrete blocker.",
  })),

  attempted_actions: Type.Optional(Type.Array(
    Type.String({ maxLength: 240 }),
    { maxItems: 8 },
  )),

  suggested_action: Type.Optional(Type.String({ maxLength: 1000 })),
  completion_summary: Type.Optional(Type.String({ maxLength: 4000 })),
});
```

Runtime validation requires `reason` for both `blocked` and `paused`.

## 68. Blocker fingerprint

The fingerprint distinguishes materially different blockers without changing when usage or timestamps change.

```ts
interface BlockerFingerprintInput {
  goalId: string;
  objectiveHash: string;
  verificationContractHash: string;
  taskStateHash: string;
  currentTaskId?: string;
  normalizedReason: string;
}

function normalizeBlockerReason(reason: string): string {
  return reason
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildBlockerFingerprint(
  goal: GoalRecord,
  reason: string,
): string {
  const input: BlockerFingerprintInput = {
    goalId: goal.id,
    objectiveHash: shortHash(goal.objective),
    verificationContractHash: shortHash(goal.verificationContract ?? ""),
    taskStateHash: shortHash(renderTaskStateForFingerprint(goal.taskList)),
    currentTaskId: goal.currentTaskId,
    normalizedReason: normalizeBlockerReason(reason),
  };

  return sha256(JSON.stringify(input)).slice(0, 24);
}
```

Do not include revision, `updatedAt`, token usage, elapsed time, or audit animation state.

## 69. Ledger events

Add:

```ts
type OracleStartedEvent = {
  type: "oracle_started";
  goalId: string;
  fingerprint: string;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  reason: string;
  at: string;
};

type OracleResultEvent = {
  type: "oracle_result";
  goalId: string;
  fingerprint: string;
  adviceId: string;
  disposition: "actionable" | "needs_human" | "insufficient_context";
  summary: string; // bounded
  recommendedTitle?: string;
  at: string;
};

type OracleFailedEvent = {
  type: "oracle_failed";
  goalId: string;
  fingerprint: string;
  attempt: number;
  errorCode: "config" | "provider" | "aborted" | "invalid_output";
  message: string; // bounded
  at: string;
};

type OracleFollowupAttemptedEvent = {
  type: "oracle_followup_attempted";
  goalId: string;
  fingerprint: string;
  adviceId: string;
  firstToolName: string;
  at: string;
};
```

Add reconstruction helpers:

```ts
function oracleStateForFingerprint(
  events: GoalLedgerEvent[],
  goalId: string,
  fingerprint: string,
): OracleConsultState;
```

## 70. Structured Oracle output

```ts
const OracleAdviceSchema = Type.Object({
  diagnosis: Type.String({ maxLength: 2000 }),

  alternatives: Type.Array(
    Type.Object({
      title: Type.String({ maxLength: 200 }),
      rationale: Type.String({ maxLength: 1000 }),
      steps: Type.Array(
        Type.String({ maxLength: 400 }),
        { minItems: 1, maxItems: 8 },
      ),
      expectedEvidence: Type.Array(
        Type.String({ maxLength: 400 }),
        { maxItems: 8 },
      ),
    }),
    { minItems: 1, maxItems: 4 },
  ),

  recommendedIndex: Type.Integer({ minimum: 0, maximum: 3 }),

  unresolvedQuestions: Type.Array(
    Type.String({ maxLength: 400 }),
    { maxItems: 6 },
  ),

  disposition: StringEnum([
    "actionable",
    "needs_human",
    "insufficient_context",
  ]),
});
```

The nested session receives one custom submit tool. It does not rely on parsing prose markers.

## 71. Oracle session isolation

```ts
async function runBlockerOracle(args: {
  ctx: ExtensionContext;
  goal: GoalRecord;
  reason: string;
  attemptedActions: string[];
  settings: ResolvedOracleSettings;
  recentEvidence: string;
  signal?: AbortSignal;
}): Promise<OracleRunResult> {
  const model = resolveExplicitOracleModel(args.ctx, args.settings);
  if (!model.ok) return configFailure(model.message);

  const submitted = deferred<OracleAdvice>();
  const submitTool = defineSubmitOracleAdviceTool(submitted);

  const resources = args.settings.projectResources
    ? projectResourceLoaderOptions()
    : isolatedReadOnlyResourceLoader();

  const { session } = await createAgentSession({
    cwd: args.ctx.cwd,
    model: model.value,
    thinkingLevel: args.settings.thinkingLevel,
    ...resolveAuditorSessionModelOptions(args.ctx),
    resourceLoader: resources.loader,
    resourceLoaderOptions: resources.options,
    sessionManager: SessionManager.inMemory(args.ctx.cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
    }),
    tools: ["read", "grep", "find", "ls", "submit_goal_oracle_advice"],
    customTools: [submitTool],
  });

  subscribeOracleProgressFromSessionEvents(session);

  const abort = () => session.abort();
  args.signal?.addEventListener("abort", abort, { once: true });

  try {
    await session.prompt(buildOraclePrompt(args));
  } finally {
    args.signal?.removeEventListener("abort", abort);
  }

  if (args.signal?.aborted) return abortedFailure();
  if (!submitted.settled) return invalidOutputFailure();

  return { ok: true, advice: submitted.value };
}
```

No `bash`, `write`, or `edit` tool is exposed. Project resources remain opt-in.

## 72. Oracle prompt

Case-specific information appears once:

```ts
function buildOraclePrompt(args): string {
  return [
    "You are a read-only blocker adviser.",
    "Find concrete alternative paths. Do not mutate files.",
    "Do not mark the goal complete or blocked.",
    "Return advice only through submit_goal_oracle_advice.",

    xml("objective", escapePayload(args.goal.objective)),
    xml("verification_contract", escapePayload(args.goal.verificationContract)),
    xml("current_task", renderCurrentTaskOnce(args.goal)),
    xml("pending_task_preview", renderPendingPreview(args.goal, 5)),
    xml("blocker_reason", escapePayload(args.reason)),
    xml("attempted_actions", renderAttempts(args.attemptedActions)),
    xml("recent_evidence", escapePayload(args.recentEvidence)),

    "Inspect relevant files with read-only tools before advising when needed.",
  ].filter(Boolean).join("\n\n");
}
```

The full conversation is not copied into the Oracle request.

## 73. Block transition state machine

```ts
async function runGoalBlockedFlow(
  ctx: ExtensionContext,
  reasonInput?: string,
  attemptedActionsInput?: string[],
): Promise<AgentToolResult<unknown>> {
  core.reconcileFocusedGoalFromDisk(ctx);

  const gate = validateGoalBlock(...);
  if (!gate.ok) return failure(gate.message);

  const reason = normalizeRequiredReason(reasonInput);
  if (!reason.ok) return failure(reason.message);

  core.flushGoalTransaction(ctx);

  const goal = requireFocusedGoal();
  const settings = loadGoalSettings(ctx.cwd);
  const oracle = settings.oracle;

  if (!oracle.enabled) {
    return commitBlocked(goal, reason.value, {
      source: "agent",
      oracle: undefined,
    });
  }

  const fingerprint = buildBlockerFingerprint(goal, reason.value);
  const ledger = readGoalLedger(ctx).events;
  const consult = oracleStateForFingerprint(
    ledger,
    goal.id,
    fingerprint,
  );

  // One actionable result already exists.
  if (consult.result?.disposition === "actionable") {
    if (!consult.followupAttempted) {
      core.runtime.armOracleAdvice(consult.result);
      return {
        terminate: false,
        content: [{
          type: "text",
          text: renderOracleAdviceReminder(consult.result),
        }],
        details: goalDetails(goal),
      };
    }

    // The executor attempted the advice and still reports the same blocker.
    return commitBlocked(goal, reason.value, {
      source: "agent",
      oracle: consult.result,
    });
  }

  // Oracle already concluded that human input is required.
  if (
    consult.result?.disposition === "needs_human" ||
    consult.result?.disposition === "insufficient_context"
  ) {
    return commitBlocked(goal, reason.value, {
      source: "agent",
      oracle: consult.result,
    });
  }

  if (consult.failedAttempts >= oracle.maxFailedAttemptsPerBlocker) {
    return commitBlocked(goal, reason.value, {
      source: "agent",
      oracleFailure: consult.latestFailure,
    });
  }

  const focusToken = core.focusedOperationToken(goal.id);
  appendOracleStarted(...);

  const run = await runBlockerOracle({
    ctx,
    goal,
    reason: reason.value,
    attemptedActions: boundedAttempts(attemptedActionsInput),
    settings: oracle,
    recentEvidence: buildBoundedOracleEvidence(goal, ledger),
    signal: core.runtime.oracleAbortSignal(),
  });

  if (!core.isFocusedOperationCurrent(focusToken)) {
    return core.focusedOperationCancelledResult(
      "Blocker Oracle",
      focusToken,
    );
  }

  if (!run.ok) {
    appendOracleFailed(...);

    if (run.errorCode === "aborted") {
      return {
        terminate: false,
        content: [{
          type: "text",
          text: "Oracle consultation was aborted; the goal remains active.",
        }],
        details: goalDetails(goal),
      };
    }

    return {
      terminate: false,
      content: [{
        type: "text",
        text: renderOracleFailureAndNextAction(run),
      }],
      details: goalDetails(goal),
    };
  }

  const resultEvent = persistBoundedOracleResult(run.advice, fingerprint);
  appendOracleResult(resultEvent);

  if (run.advice.disposition !== "actionable") {
    return commitBlocked(goal, reason.value, {
      source: "agent",
      oracle: resultEvent,
    });
  }

  core.runtime.armOracleAdvice(resultEvent);

  return {
    terminate: false,
    content: [{
      type: "text",
      text: renderActionableOracleAdvice(run.advice),
    }],
    details: goalDetails(goal),
  };
}
```

## 74. Recording a post-advice attempt

In `tool_call`:

```ts
if (
  core.runtime.hasPendingOracleAdviceForFocusedGoal() &&
  isMeaningfulProgressToolCall(event.toolName, event.args)
) {
  const pending = core.runtime.consumeOracleFollowupMarker();

  core.goalService.appendEvents(ctx, [{
    type: "oracle_followup_attempted",
    goalId: pending.goalId,
    fingerprint: pending.fingerprint,
    adviceId: pending.adviceId,
    firstToolName: event.toolName,
    at: nowIso(),
  }]);
}
```

Exclude:

- `get_goal`;
- echo-only bash;
- reads of `.pi/goals`;
- Oracle/auditor progress surfaces;
- repeated `update_goal(blocked)` itself.

## 75. Failure and cancellation policy

| Condition | Result |
|---|---|
| Oracle disabled | Existing block transition. |
| Enabled but provider/model incomplete | Keep active; return configuration error; do not silently fallback. |
| Model unavailable | Keep active; record `oracle_failed(config)`. |
| User aborts consultation | Keep active; record `oracle_failed(aborted)` or `oracle_aborted`; no block. |
| Transient provider failure below limit | Keep active; report retryable failure. |
| Failure limit reached for fingerprint | Permit block with durable Oracle failure annotation. |
| Actionable advice | Keep active and return advice. |
| Same actionable advice, no subsequent work | Do not call Oracle again and do not block; remind executor to try it. |
| Same actionable advice after meaningful work | Permit block. |
| `needs_human` | Block immediately with Oracle summary. |
| Focus changes during consultation | Discard result; do not mutate old or new goal. |
| Goal completes during consultation | Discard result. |
| Oracle attempts mutation | Impossible because tools are read-only. |

## 76. Oracle UI

During consultation:

```text
Oracle · provider/model · inspecting files
```

After actionable result:

```text
Oracle suggested an alternative path
```

Do not keep the full advice in the always-visible widget. Full advice remains in the tool result and bounded ledger summary.

`get_goal({verbose:true})` and `/goal-status verbose` show the latest Oracle disposition and short recommendation.

## 77. Oracle tests

- default disabled path is byte-identical except the newly required block reason where deliberately changed;
- enabled requires explicit provider/model;
- provider-only refused;
- first blocked request invokes exactly one Oracle;
- Oracle session has only read/grep/find/ls/submit tools;
- project resources off by default;
- project resources opt-in;
- objective and blocker payload escaping;
- structured output validation;
- invalid output;
- actionable result keeps goal active;
- no second consult for same fingerprint;
- no block before a follow-up work attempt;
- follow-up work event persisted;
- same blocker after follow-up can block;
- changed reason produces new fingerprint;
- changed task state produces new fingerprint;
- usage/revision changes do not produce a new fingerprint;
- `needs_human` blocks;
- insufficient context blocks with clear reason;
- provider failure bounded;
- abort keeps active;
- focus change cancels commit;
- ledger append failures do not falsely claim consultation success;
- global/project Oracle settings inheritance;
- Oracle model choice can be unset to inherit;
- no token/context regression outside the Oracle turn;
- no unbounded advice in prompt, widget, or ledger.

## 78. Oracle commit sequence

```text
docs(spec): define read-only blocker Oracle lifecycle
feat(settings): add layered Oracle configuration
refactor(models): generalize auditor model selector for advisory roles
feat(oracle): add isolated structured Oracle session
feat(goal): route blocked outcomes through Oracle state machine
feat(ledger): persist Oracle consultation and follow-up events
feat(ui): surface bounded Oracle progress and results
test(oracle): cover lifecycle isolation failures and inheritance
bench(context): measure Oracle request and steady-state overhead
docs(oracle): document configuration cost and behavior
```

## 79. Issue #26 merge and closure

Close issue #26 only after:

- the feature is merged;
- default-off behavior is verified;
- an actionable-advice journey is demonstrated;
- a needs-human journey is demonstrated;
- token/context measurements are attached;
- `main` CI is green.

Post:

```text
Implemented in <merge-sha>.

The Oracle is opt-in and explicitly configured. It is read-only, runs once
per blocker fingerprint, keeps the goal active when it returns actionable
advice, and allows the normal blocked transition only after the advised path
has been attempted or the Oracle concludes that human input is required.
```

---

## 80. Paired outcome non-inferiority gate

Token reduction cannot be validated from prompt size alone.

### 80.1 Deterministic protocol gate

For each candidate branch:

- all state-machine tests pass;
- required semantic markers remain;
- no new unsafe tool exposure;
- stale checkpoints cannot execute work;
- no premature completion;
- no premature block;
- no autonomous focus;
- every contracted task requires evidence;
- Sisyphus order is retained.

Any failure is an unconditional merge blocker.

### 80.2 Paired live-agent gate

Run baseline and candidate from identical fixture snapshots.

```ts
interface PairedRun {
  journeyId: string;
  model: string;
  seed?: number;
  baseline: RunResult;
  candidate: RunResult;
}
```

Models:

- one cheap executor model representative of the main use case;
- one stronger general model;
- one model from a different provider family where available.

For each journey/model pair:

- use the same starting repository;
- use the same user messages;
- use the same settings;
- use the same seed when supported;
- grade actual artifacts and ledger state;
- do not grade the assistant’s claim alone.

Hard rule:

```ts
if (baseline.passed && !candidate.passed) {
  failMerge("baseline-pass/candidate-fail");
}
```

Aggregate rule:

```text
candidate pass count must be >= baseline pass count for every journey class
candidate critical-safety failures must equal zero
candidate evidence-completeness score must be >= baseline
```

Record input, output, cache-read, and cache-write tokens separately.

### 80.3 Independent adjudication

Use a fixed rubric and an independent evaluator that receives:

- user objective;
- final repository diff;
- test output;
- goal record;
- ledger tail;
- no branch label revealing baseline/candidate.

Store redacted aggregate results under:

```text
specs/<optimization-spec>/EVAL-RESULTS.md
```

No user repository content or credentials are committed.

---

## 81. Full validation gate for every PR

Run from a clean checkout of the exact head:

```bash
rm -rf node_modules
npm ci

npm run check
npm run lint
npm run test:all
npm run test:selfcheck
npm run test:serial

npm pack --dry-run
npm audit --omit=dev

npm run bench:gate:naf
npm run context:gate        # once PR D lands
npm run context:eval:fake   # once PR D lands

node scripts/verify-pr-head.mjs \
  --base origin/main \
  [--forbid-ancestor ...]
```

Issue-specific commands:

```bash
npm run test:checkpoint-recovery   # PR A
npm run test:settings-race         # PR B
npm run test:oracle                # PR G
```

Before merge:

1. fetch `origin/main`;
2. rebase;
3. rerun the entire gate;
4. push normally or with the original PR branch lease;
5. wait for GitHub `validate`;
6. fetch the PR head SHA from GitHub;
7. compare it to the locally validated SHA;
8. merge with `expected_head_sha`;
9. wait for `main` CI;
10. rerun package smoke tests from `main`.

---

## 82. Merge method

Use a merge commit for each maintainer-owned PR:

- it preserves the intentionally separated commits;
- it gives a single revert point;
- it makes issue closure and release notes traceable.

Do not squash an original contributor branch as a substitute for the clean-history requirement.

Example merge parameters:

```text
method: merge
expected_head_sha: <validated head>
title: <PR title> (#<number>)
message:
  - implementation summary
  - validation commands
  - issue/PR references
```

---

## 83. Rollback plan

### 83.1 Code rollback

For any regression:

```bash
git switch main
git pull --ff-only
git revert -m 1 <merge-commit-sha>
git push origin main
```

Open a rollback PR when branch protection requires it. Never force-reset main.

### 83.2 Issue #30 rollback

Do not restore full checkpoint persistence. If a downstream incompatibility appears:

- keep v2 checkpoint content;
- revert only context-filtering or ancillary UI changes;
- add a provider-specific compatibility patch;
- leave the recovery CLI available.

### 83.3 Settings rollback

Before any settings mutation, the atomic layer writer may optionally maintain one `.bak` file per settings path. Release notes must state:

- older pi-goal-x versions ignore the new global file because they do not read it;
- older versions may reject newly added keys in the project file;
- downgrade instructions remove or move unsupported keys before installing the older version.

### 83.4 Oracle rollback

Oracle is default off. Emergency mitigation:

```json
{
  "oracle": {
    "enabled": false
  }
}
```

The normal blocked path remains available. Ledger events remain readable as unknown/non-actionable historical events after a code rollback.

### 83.5 Prompt optimization rollback

For one minor release, retain:

```text
PI_GOAL_PROMPT_PROFILE=legacy-v1
```

This rollback flag never restores the issue #30 full-checkpoint defect.

---

## 84. Release plan

### Release 0.27.5

Contents:

- issue #30 runtime fix;
- context filtering;
- checkpoint health;
- offline recovery CLI;
- regression benchmarks.

Release checks:

- install package tarball into a clean temporary Pi environment;
- run a 100-turn synthetic goal;
- inspect session JSONL;
- dry-run recovery on legacy fixture;
- confirm package bin executable.

### Release 0.28.0

Contents:

- layered global settings;
- inheritance-aware settings UI;
- `hideUnfocusedBanner`;
- documentation and provenance reports.

Release checks:

- global-only config;
- project false/zero override;
- concurrent edits;
- Windows and POSIX path tests;
- live banner hide/restore.

### Release 0.29.0

Contents:

- complete context measurement;
- low-risk prompt deduplication;
- UI/model payload separation;
- blocker Oracle.

Release checks:

- paired non-inferiority report;
- Oracle disabled default;
- actionable and needs-human Oracle journeys;
- no context regression on ordinary non-Oracle turns.

---

## 85. PR and issue communication templates

### 85.1 Existing PR history replacement

```text
The branch has now been replaced with a maintainer-owned implementation
based directly on current main.

Old head: <old-sha>
New head: <new-sha>

Verification:
- old head is not an ancestor of new head
- no original submitter commit is present
- no cherry-pick, patch apply, or co-author trailer was used
- full validation: <commands>
```

### 85.2 Replacement PR fallback

```text
This PR is being closed unmerged because its fork branch cannot be rewritten
by maintainers while satisfying the requirement that no submitter commit be
merged. The feature has been independently reimplemented in <replacement PR>.
No commit from this PR is present in the replacement history.
```

### 85.3 Merge evidence

```text
Merged as <merge-sha> from reviewed head <head-sha>.

Local and GitHub validation:
- npm run check
- npm run lint
- npm run test:all
- npm run test:selfcheck
- npm run test:serial
- npm pack --dry-run
- npm audit --omit=dev
- npm run bench:gate:naf
- issue-specific gates
```

---

## 86. End-to-end checklist

### Repository safety

- [ ] Safety tag created.
- [ ] Main branch protection enabled.
- [ ] Baseline validation recorded.
- [ ] Old PR head SHAs recorded.
- [ ] Original PR comments posted before history replacement.

### Issue #30

- [ ] Spec committed.
- [ ] Reproducer fails before fix.
- [ ] v2 marker implemented.
- [ ] Full goal prompt removed from checkpoint persistence.
- [ ] Context retains at most one marker.
- [ ] Full active state injected exactly once.
- [ ] Legacy parser compatibility retained.
- [ ] Checkpoint health report added.
- [ ] Offline recovery CLI added.
- [ ] Recovery backup/graph/idempotence tests pass.
- [ ] 1,000-turn growth benchmark passes.
- [ ] PR merged.
- [ ] Main CI passes.
- [ ] 0.27.5 released.
- [ ] Issue #30 closed with measurements.

### PR #27

- [ ] Clean branch starts at current main.
- [ ] No contributor commit or patch used.
- [ ] Sparse layer and resolved settings types separated.
- [ ] Pure global path resolution implemented.
- [ ] Global/project/env/default resolver implemented.
- [ ] Per-leaf keybinding merge implemented.
- [ ] Diagnostics implemented.
- [ ] Atomic locked mutation implemented.
- [ ] Inherit/unset UI implemented.
- [ ] Concurrency and fault tests pass.
- [ ] Original branch force-replaced with lease, or replacement PR opened.
- [ ] Provenance gate passes.
- [ ] PR merged.

### PR #29

- [ ] Based on merged global-settings implementation.
- [ ] Layered true/false override implemented.
- [ ] Live UI refresh implemented.
- [ ] Focused dashboard unaffected.
- [ ] Model-facing unfocused prompt unchanged.
- [ ] Original branch force-replaced with lease, or replacement PR opened.
- [ ] Provenance gate passes.
- [ ] PR merged.
- [ ] 0.28.0 released.

### Token journey

- [ ] Composed request capture includes tool schemas.
- [ ] Baseline artifacts committed.
- [ ] Semantic occurrence counts committed.
- [ ] Current task/task-contract deduplicated.
- [ ] Lifecycle rule text has one source.
- [ ] `get_goal` default/verbose behavior tested.
- [ ] Rich human display separated from concise model content.
- [ ] Audit-start display no longer triggers a turn.
- [ ] Auditor progress tool removed.
- [ ] Auditor objective/tasks occur once.
- [ ] Post-compaction delta avoids full state repetition.
- [ ] Prompt fallback profile retained for one release.
- [ ] Paired non-inferiority gate passes.

### Issue #26

- [ ] Product and technical specs committed.
- [ ] Oracle disabled by default.
- [ ] Explicit provider/model required.
- [ ] Read-only tool profile enforced.
- [ ] Structured advice schema enforced.
- [ ] Fingerprint stable and tested.
- [ ] One successful consult per fingerprint.
- [ ] Follow-up attempt recorded.
- [ ] Actionable advice keeps goal active.
- [ ] Needs-human advice blocks correctly.
- [ ] Failure/abort/focus-change behavior tested.
- [ ] Global/project settings inheritance tested.
- [ ] Context and cost measured.
- [ ] PR merged.
- [ ] Main CI passes.
- [ ] Issue #26 closed.
- [ ] 0.29.0 released.

---

## 87. Final completion report

After all releases, create:

```text
specs/2026-08-23-maintainer-resolution-program/
  PRODUCT.md
  TECH.md
  MILESTONES.md
  FINAL-VALIDATION.md
  CONTEXT-DIFF.md
  EVAL-RESULTS.md
```

`FINAL-VALIDATION.md` records:

- every PR number;
- old and new branch heads;
- forbidden-ancestor checks;
- merge SHAs;
- release versions;
- exact test counts;
- benchmark before/after rows;
- checkpoint recovery measurements;
- settings race-test results;
- paired outcome results;
- issue closure links;
- any follow-up work explicitly left out.

The program is not declared complete from PR merge status alone. Completion requires shipped releases, successful post-release smoke tests, closed issues with evidence, and a final provenance and outcome-quality record.
