# C9-clear-mid-sisyphus
# Test: user runs /goal-clear while a sisyphus goal is executing; the agent should stop, with no active goal left behind.
TURN: /goal-sisyphus "Step 1: create a.txt with 'a'. Step 2: append content of missing.txt to a.txt. missing.txt will be provided later by the user. For step 1 step_complete, pass verifyCommand `test -f a.txt && [ \"$(cat a.txt)\" = a ]`. After clear, do not try to recover or create missing files yourself."
TURN: 
TURN: /goal-clear
