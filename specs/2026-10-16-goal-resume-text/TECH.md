# Tech: /goal-resume optional trailing text

## Files touched

| File | Change |
| --- | --- |
| `extensions/goal-commands.ts` | `handleGoalResume` gains `rawArgs`; delivery block before resume; command threads `rawArgs`; description updated |
| `README.md` | Command table row mentions optional trailing text |
| `tests/goal-resume-text.test.ts` | Delivery coverage |
| `tests/.test-manifest.json` | New unit entry registered via `--write-manifest` |
| `CHANGELOG.md` | [Unreleased] Added entry |

## Delivery (`goal-commands.ts`)

At the top of `handleGoalResume`, before `reconcileFocusedGoalFromDisk`:

```ts
const text = (rawArgs ?? "").trim();
if (text) {
  try {
    core.pi.sendUserMessage(text, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
  } catch (err) {
    ctx.ui.notify("Could not deliver message to the agent: " + (err instanceof Error ? err.message : String(err)), "error");
  }
}
```

Same delivery pattern as `goal-drafting.ts:182`. Delivery precedes every
early return (no focused goal, picker cancellation, `scheduler.resume`
returning false) so text is never dropped. The in-file comment at the
delivery block records the ordering rationale; PRODUCT.md "Ordering
rationale" carries the full version.

Realistic `sendUserMessage` failures (missing model, auth, compaction in
progress) reject asynchronously and surface through pi's own extension-error
channel, not this try/catch notification: the catch only fires for a stale
or uninitialized extension runtime.
