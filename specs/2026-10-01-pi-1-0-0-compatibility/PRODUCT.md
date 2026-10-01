# pi 1.0.0 compatibility

Make pi-goal-x fully compatible with pi 1.0.0. The installed host is pi 1.0.0
(`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` reports `1.0.0`), while the
extension currently pins `>=0.83.0 <0.85.0` and develops against 0.84.1. This spec moves the
project onto the 1.x line, keeps all goal behavior intact, adopts the 1.0 APIs that clearly
improve goal workflows, updates the documentation, and prepares a 0.32.0 release entry.

## Scope

In scope:

- `package.json` peer/dev dependency ranges and the installed dependency tree.
- Extension source under `extensions/` and any SDK contract drift in pi-tui, pi-ai, and
  pi-coding-agent.
- Tests under `tests/` (unit, integration, e2e) and their fixtures/harnesses.
- Documentation that states a pi version requirement: `README.md`, `docs/`, `CHANGELOG.md`.
- Version bump to 0.32.0 with a matching changelog entry.

Out of scope:

- Publishing to npm. The release is *prepared*, not published.
- Unrelated feature work or refactors that 1.0.0 does not require.
- Upgrading pi itself, or changing other packages in this workspace.
- Backporting 1.0-only behavior to 0.8x hosts. 1.0.0 is the only supported line after this spec.

## Success criteria

1. `package.json` peerDependencies and devDependencies target
   `@earendil-works/pi-ai|pi-coding-agent|pi-tui` `^1.0.0`, and the resolved `node_modules`
   tree is 1.0.0. No 0.8x constraint survives in `package.json` or the lockfile.
2. `npm run check` (`tsc --noEmit`) is clean against the 1.0.0 type declarations.
3. `npm run lint` is clean.
4. `npm test` passes with zero failures across the suites the default runner executes,
   including the golden, dashboard, surface-baseline, and RPC dialog tests.
5. The extension loads into a live pi 1.0.0 session and a complete goal lifecycle
   (draft → confirm → execute → audit → complete) runs without runtime errors from changed
   APIs. The known risky contract is `ExtensionAPI.on()` now returning an unsubscribe
   function, plus any pi-tui component, key, or theme contract changes.
6. Each new 1.0 capability that could benefit goals — `agent_before_settle`,
   `session_compact_failed`, `context_with_system`, `getSettings()`, `on()` unsubscribe
   returns, MCP/virtual-model registration — is either adopted with tests or explicitly
   rejected in `MILESTONES.md` with rationale. Silence is not an acceptable outcome.
7. `README.md`, `docs/`, and `CHANGELOG.md` state the pi 1.0.0 requirement, and `package.json`
   is at version 0.32.0 with an Unreleased-consistent changelog entry.

## Constraints

- **Behavioral parity is the default.** A migration must not silently change goal semantics.
  Any intentional behavior change is recorded in this file before implementation.
- **Smallest correct change.** Working goal logic is not refactored merely to use a new API.
  Adoption under criterion 6 is deliberate, opportunistic, and must earn its complexity.
- **Tests are the regression gate.** No test may be deleted or weakened to make the upgrade
  pass. Tests change only to follow a genuine API change, and every such change is noted.
- **Spec-first steering.** Per `AGENTS.md`, update `PRODUCT.md` first when behavior changes,
  then implementation, tests, and `MILESTONES.md`.

## Known pre-existing state

At the start of this spec the working tree carried uncommitted changes for a separate feature
(issue #59: token-budget changes through `/goal-tweak`). That work is unrelated to the 1.0.0
migration and is neither committed nor reverted here; it is treated as a fixed part of the
baseline. Baseline test numbers therefore describe 0.84.1 *with* that feature applied.
