# C24 — Multi-goal focus: creating/focusing one goal does not mutate others

## Behavior under test

Multiple open goals must survive creating and focusing a new goal. Creating a
goal must not archive, pause, or alter the other open goals. The result of
create_goal should state that the new goal became the session focus without
touching the others.

Expected:
- a second goal created with create_goal while the first is active;
- both goal files remain on disk, unmodified;
- the session focus is the newest goal;
- no clear/abort/pause tools are called.

## Prompts

TURN: /goal Create file one.txt with content 'one'.
TURN: /goal Create file two.txt with content 'two'. (Keep the first goal open.)
