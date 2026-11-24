# Commands and keys

Open `/goal-settings` and choose **Controls**, or run `/goal-settings controls`.
The screen has three sections: **Commands**, **Keys** and **Pausing**. Type to
filter, use the arrow keys and Enter to edit, and Tab to switch sections.
Page Up/Down moves through long lists; Home/End jumps to the first/last row.
Ctrl+S switches between **This project** and **All projects**. The selected row shows
whether its value comes from the project, global settings or the default.

Changes are saved when you choose Save or confirm a recorded key. Escape backs
out of an edit without saving. **Use inherited value** removes a project
override; **Remove global override** restores the default. **Use default** pins
the default in the selected scope. Each section also has a reset action that
removes only that section's overrides in the selected scope.

## Commands

Each action has a preferred command followed by any aliases. Choose **Edit
command paths** to replace them, **Add an alias** to keep the current spellings,
or **Disable** to remove its command invocations. For example, add `/goal edit`
to **Revise the goal** to use the existing confirmation workflow with that
spelling. Arguments after the command path are passed through to the action.
Subcommands appear in argument completion; the longest matching complete path
wins. A routing-only root lists its available subcommands when called without
a matching action.

Command changes need a reload. The screen shows when changes are pending;
Ctrl+R applies them while Pi is idle when controls were opened through a slash
command. If controls were opened from a shortcut, close them and run `/reload`.
Keys and pause order take effect immediately.

`/goal-settings` always remains available as a recovery entry. You can give the
settings action other spellings, but this entry cannot be removed. Pi command
roots such as `/reload` and `/settings` are reserved. The editor checks conflicts
with other commands before saving.
For settings, **Recovery entry only** removes additional aliases while keeping
`/goal-settings` available.

The settings keys below are stable action IDs, even after renaming an invocation:

| Action ID | Action |
| --- | --- |
| `goal` | Guided goal draft |
| `sisyphus` | Guided Sisyphus draft |
| `goal-direct` | Immediate goal creation |
| `sisyphus-direct` | Immediate Sisyphus creation |
| `goal-tweak` | Confirmed revision |
| `goal-pause` | Pause goal and stop turn |
| `goal-resume` | Resume and renew the run allowance |
| `goal-clear` | Confirmed archival |
| `goal-list` | List open goals |
| `goal-status` | Status; also accepts `verbose` or `health` |
| `goal-refresh` | Read state and settings again |
| `goal-recovery` | Recovery report; also accepts `repair` |
| `goal-focus` | Choose a goal |
| `goal-unfocus` | Detach this session |
| `goal-settings` | Settings and controls |
| `goal-cancel` | Cancel a draft |

## Keys

Choose an action under **Keys**, then record a key or edit its Pi key names.
**Record another key** adds a second binding. **Disable** leaves it unbound.
Conflicts are checked before saving; errors leave your input available to fix.
Use a free key or change a conflicting Pi binding in its `keybindings.json`.

Every public goal shortcut is listed: pause, audit interruption, auditor toggle,
dashboard expansion, compact scrolling, expanded navigation, and goal dialog
controls. Each command action can also have a shortcut, independently of its
slash command names. A shortcut for direct creation or revision asks for the
objective or change before invoking the usual workflow.

Goal dialog controls apply to questionnaires and confirmation dialogs. They
have their own context, so the same key can confirm a dialog and pause a live
goal. Text editing and the settings screen use Pi's usual UI controls. The
settings screen remains usable when you change goal dialog navigation.
While typing an answer, letters and Pi's editing keys keep editing text. Escape
leaves the answer editor; free custom keys such as F7 can do the same.

Pi key names include `escape`, `f6`, `ctrl+alt+p`, `pageUp` and `super+k`. Multiple
keys can be separated with commas. For a comma key combined with other bindings,
the text editor also accepts a JSON key list, for example `["ctrl+,", "f6"]`.
Existing comma-key lists reopen in this form so they can be saved unchanged.
Terminals must report a key before Pi can use it; some modifier combinations
require the Kitty keyboard protocol. See [Pi's keybinding reference](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/keybindings.md).

## Pausing

The default is still Escape, with **Goal and turn together**. An open dialog
owns its input; closing the expanded dashboard or interrupting an audit takes
priority over pausing in that view.

| Pause order | First press | Next press |
| --- | --- | --- |
| Goal and turn together | Pause the goal and stop the turn | Pi's normal interrupt |
| Goal first | Pause the goal; let the current turn finish | Stop the remaining turn |
| Turn first | Stop the turn and wait for the user, keeping the goal active | Pause the goal |

Goal first finishes the current Pi turn, then stops before another model
request. A turn-only stop holds automatic continuation, provider recovery and wake-ups.
It does not spend another run allowance. Resume or send a new user message to
continue. Reloading an interrupted autonomous run does not replay it.

When you move the pause key away from Pi's interrupt key, Pi's interrupt stops
the turn and waits for you without pausing the goal. The configured pause key
uses the selected order. The explicit **Pause the goal** command always stops
both the goal and its turn, including a turn left running by **Goal first**.

## Settings files

The UI writes the existing sparse settings layers:

- Global: `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-goal-x-settings.json`.
- Project: `<project>/.pi/pi-goal-x-settings.json`.

Project leaves override global leaves. Missing leaves inherit; an empty list
explicitly disables an action. Existing `keybindings.dashboard` settings keep
their meaning. For example:

```json
{
  "commands": {
    "goal-tweak": ["goal-tweak", "goal edit"],
    "goal-resume": ["work continue"]
  },
  "pauseOrder": "turn-first",
  "keybindings": {
    "pause": ["f6", "ctrl+alt+p"],
    "toggleAuditor": "ctrl+alt+a",
    "interruptAudit": "escape",
    "dashboard": { "toggleExpand": "ctrl+alt+t" },
    "dialog": { "confirm": "enter", "cancel": "escape" },
    "commands": { "goal-settings": "f10", "goal-status": [] }
  }
}
```

Use `/goal-refresh` after external key or pause-order edits, and `/reload` after
external command edits. Verbose goal status reports the effective controls and
their sources.
