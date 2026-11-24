## 2026-11-24, third pass

- Plan written (TECH.md). Work split into separate PRs.

## Settings split

- `extensions/goal-settings.ts` (954 lines) is replaced by `extensions/settings/`: `schema.ts` (types, keybinding defaults, layer parser), `files.ts` (paths, layer reads, file cache), `resolve.ts` (layered snapshot, env overrides, report) and `mutate.ts` (path lock, atomic write). Imports run schema <- files <- resolve <- mutate, with no cycles.
- Only `extensions/goal.ts` is the package entry point, so no re-export shim was kept; all importers in extensions, tests and bench scripts point at the new modules.
- `invalidateGoalSettingsCache` now clears only the file cache. The resolved-snapshot cache is keyed on layer object identity, so fresh reads can never hit a stale entry.
- Parser cases for keybindings, oracle and networkRecovery became helper functions. Behavior and error messages are unchanged.
- `experiments/continuation/*` still names `goal-settings.ts`: it works on frozen `git archive` copies of old commits, so it was left alone.
- Validation: check, lint and all unit tests pass (1258 tests, 5 skipped, same as before).
