---
name: e2e-test-runner
description: "Historical pi-goal end-to-end runner; unsupported on the 0.22 five-tool interface."
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: true
defaultContext: fork
---

# Unsupported historical runner

This runner is intentionally disabled for 0.22. The previous protocol used
removed completion parameters, bypassed the real auditor, and assumed legacy
session state, so it did not validate the shipped interface.

Do not install or invoke this agent. Use the supported local checks:

```bash
npm run check
npm run test:serial
npm pack --dry-run
```

The replacement handler-level integration suite is specified in the
[2026-08-04 hardening plan](../../specs/2026-08-04-goal-simplification-hardening/TECH.md).
It must call the actual five registered tools, use an auditor fixture rather
than a model-only bypass, and be included by the project validation scripts.
