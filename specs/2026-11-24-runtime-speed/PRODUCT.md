# Runtime speed and prompt caching

## Goal

Make the extension cheaper to run, in wall clock and in prompt-cache terms,
without changing anything the user or the model sees.

## User-visible behavior

None. Prompts, tool schemas, commands, dialogs, settings and saved files read
the same. Two small things differ underneath:

- A goal's revision number no longer goes up a second time at the end of a turn
  when nothing changed after the turn-end save.
- Command-only code (`/goal-settings`, `/goal-status`, `/goal-recovery`) loads
  the first time the command runs instead of at startup.

## Non-goals

- Changing prompt wording or tool descriptions. The prompt side was already
  within 4% to 15% of the "no goal text at all" floor (see TECH.md), and the
  wording is the contract with the model.
- CI and release workflows.
- Lazy-loading the completion flow and the questionnaire. Tests pin that the
  auditor and the dialogs start in the same tick as the tool call; see TECH.md.
