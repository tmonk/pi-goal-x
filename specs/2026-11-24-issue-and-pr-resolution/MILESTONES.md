# Milestones

## 2026-11-24

- Triage done and approved: fix #108 (task progress), #122, #125, #126, #129,
  #130, #132, #135; rewrite PRs #96, #121, #128, #131, #133, #134 with credit;
  close #123; park #119.
- W1-W9 landed as separate commits.
- First gate run after W1 failed in four places that assumed the tool list
  changed during a draft: context, provider, controls-cli and lifecycle-cli.
  All four now read the draft phase from the conversation. The controls-cli
  fake provider had looped and raced on `requests.json` before this.
- All gates and the bench gate pass.
