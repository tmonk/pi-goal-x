# Milestones

## 2026-11-24

- Baseline on `main` (b0fc15e): 1,233 tests, 1 failure when run as root
  (settings fault injection). Two more root-only failures appear in the
  integration and e2e suites.
- Dead code removed. The first scan also flagged `saveGoalSettingsFileConfig`
  and `parseGoalSettings`, but about 60 test call sites use them as fixtures,
  so they stay for now (TECH.md, "Deferred").
- Storage primitives unified. The temp-file collision test (an existing temp
  file is never deleted) still passes with the shared writer.
- First attempt at removing unused imports used TypeScript's organizeImports
  in RemoveUnused mode. It reformatted every import statement, so it was
  reverted in favor of deleting only the specifiers tsc reports.
- First indentation pass flattened JSDoc continuation lines because the raw
  scanner lost sync on regex literals. Comment ranges now come from the
  syntax tree; `git diff -w` is empty and a literal hash matches before and
  after.
- Result: extension sources 19,526 → 18,214 lines; ignoring whitespace,
  extensions and tests lose about 3,000 lines and gain about 700.
  `node scripts/run-unit-tests.mjs all`: 1,255 tests, 0 failures, 5 skipped
  (3 root-only, 2 need the pi CLI).
