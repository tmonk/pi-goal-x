# Localisation: plan

Goal (issue #119): let people translate the text the extension shows in the host
UI, without making it harder for English speakers to add features.

## Rules

- Write the English text at the call site and wrap it: `t("Goal paused.")`.
  The English text is the key and the fallback. Adding a feature needs no
  catalog edit.
- Fill values with placeholders, never by joining strings:
  `t("Token budget {percent}% used", { percent })`. A translator must be able to
  reorder words, so one sentence is one `t` call.
- Plurals use `tn(count, { one: "{n} task", other: "{n} tasks" })`.
- The first argument must be a plain string literal (no template literal with
  `${}`, no `+`), so the strings can be listed by a script. A test checks this.
- Only text a person reads in the host UI goes through `t`: notifications,
  dialog titles, options and hints, status line, widget and dashboard text,
  message renderers, command descriptions shown to the user.
- Never translate what the model sees or what is stored: prompts, tool names,
  tool descriptions and schemas, tool results, ledger events, goal files, and
  keys such as status names. Changing those changes model behavior and breaks
  prompt caching.
- Do not translate or wrap: log lines, error messages that are thrown for
  developers, test-only text, command ids (`/goal-pause`), setting keys.

## Adding a language

Create `extensions/i18n/locales/<code>.ts` that default-exports a `Catalog`
(English text -> translation; plural entries map `one`/`other`/... to text),
then add it to `LOCALES` in `extensions/i18n/locales.ts`. Set it with the
`locale` setting or `PI_GOAL_LOCALE`. Missing entries show English.

`npm run i18n:extract` lists every string in the code (`node
scripts/extract-strings.mjs`), so a translator can start from the full list.
