# C7-resume-after-pause
# Test: after /goal-resume, the agent should continue with step 2, discover it is still blocked, and pause again.
TURN: /goal-sisyphus "Sisyphus: 1) Create a.txt with content 'a'. 2) Append content of missing.txt to a.txt. missing.txt will be provided later by the user. Strict order, no skipping. For step_complete on step 1, pass verifyCommand like `test -f a.txt && [ \"$(cat a.txt)\" = a ]` so the framework can verify the file content."
TURN: 
TURN: /goal-resume
