{
  "version": 3,
  "id": "golden_fixture_goal",
  "objective": "Golden fixture goal objective",
  "status": "active",
  "autoContinue": true,
  "usage": {
    "tokensUsed": 123456,
    "activeSeconds": 3600
  },
  "sisyphus": false,
  "createdAt": "2026-08-03T09:00:00.000Z",
  "updatedAt": "2026-08-03T10:00:00.000Z",
  "activePath": ".pi/goals/active_goal_2026080317000000_golden_fixture_goal.md",
  "verificationContract": "Run npm test (0 failures) and confirm every requirement is addressed.",
  "taskList": {
    "blockCompletion": true,
    "proposedAt": "2026-08-03T09:05:00.000Z",
    "tasks": [
      {
        "id": "task-1",
        "title": "Implement core",
        "status": "complete",
        "completedAt": "2026-08-03T09:30:00.000Z",
        "evidence": "npm run check passes",
        "subtasks": [
          {
            "id": "task-1a",
            "title": "Design",
            "status": "pending",
            "verificationContract": "Design doc reviewed"
          }
        ]
      },
      {
        "id": "task-2",
        "title": "Docs",
        "status": "skipped",
        "skippedAt": "2026-08-03T09:40:00.000Z",
        "skipReason": "User cancelled docs work",
        "lightweightSubtasks": true
      }
    ]
  }
}

# Goal Prompt

Golden fixture goal objective

## Progress

- Status: running
- Auto-continue: on
- Sisyphus mode: no
- Time spent: 1h00m00s
- Tokens used: 123K (123,456) tokens
- Verification contract: Run npm test (0 failures) and confirm every requirement is addressed.

## Tasks

<!-- blockCompletion: true -->
- [x] task-1: Implement core — evidence: npm run check passes
- [~] task-2: Docs — skipped: User cancelled docs work
