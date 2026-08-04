# C18 — abort/Ctrl-C mid-turn

## Behavior under test

drive.mjs calls `session.abort()` 20 seconds after the first TURN is sent
(ABORT_AFTER_MS below), simulating a user Ctrl-C interrupting the sisyphus
chain. Verify the abort path: turn_end/message_end detects the aborted
message and pauses the goal (status paused, stopReason user, autoContinue
false).

## Prompts

ABORT_AFTER_MS: 20000
TURN: /sisyphus "Sisyphus: precisely 5 sequential steps, each requires `bash sleep 4` BEFORE the write. 1) sleep 4 + write a.txt='a'. 2) sleep 4 + write b.txt='b'. 3) sleep 4 + write c.txt='c'. 4) sleep 4 + write d.txt='d'. 5) sleep 4 + write e.txt='e'. autoContinue: true. The sleep is part of the done-when criterion; do not skip. Create the goal via create_goal immediately without further clarification."
