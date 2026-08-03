# C3 — `/goal-sisyphus` full spec should propose_goal_draft with numbered steps in the objective

## Behavior under test

In Sisyphus mode, drafting must produce explicit numbered steps. Given a clear, decomposable task, the agent should finish drafting within 1-2 turns, and the objective passed to propose_goal_draft must contain numbered steps ("1.", "2.", "3.", etc.).

## Prompts

TURN: /goal-sisyphus I want to do three things in the current directory, in order: first, create file a.txt with content "a"; second, create file b.txt with content "b"; third, merge a.txt and b.txt into c.txt so c.txt contains "a\nb" (two lines). Done criterion: a.txt, b.txt, c.txt all exist with correct content. Every step_complete call must pass a verifyCommand so the framework can automatically verify the file content (e.g. `test -f a.txt && [ "$(cat a.txt)" = a ]`). Do not modify anything outside the current directory. autoContinue: true.
