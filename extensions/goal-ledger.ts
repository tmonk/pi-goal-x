import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeRelPath, nowIso, safeIdPart, type GoalRecord } from "./goal-record.ts";

export const GOAL_LEDGER_FILE = ".pi/goals/goal_events.jsonl";

export type GoalLedgerEvent =
  | { type: "goal_created"; goalId: string; objective: string; sisyphus: boolean; autoContinue: boolean; at: string }
  | { type: "goal_focused"; goalId: string; reason: string; at: string }
  | { type: "goal_unfocused"; reason: string; at: string }
  | { type: "goal_paused"; goalId: string; reason: string; suggestedAction?: string; status?: "paused"; at: string }
  | { type: "goal_resumed"; goalId: string; reason: string; at: string }
  | { type: "goal_tweaked"; goalId: string; changeSummary: string; at: string }
  | { type: "completion_requested"; goalId: string; summary?: string; at: string }
  | { type: "audit_started"; goalId: string; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "audit_result"; goalId: string; verdict: "approved" | "disapproved" | "error"; report: string; at: string }
  | { type: "audit_skipped"; goalId: string; reason: "disabled" | "user_aborted"; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "goal_completed"; goalId: string; archivePath?: string; at: string }
  | { type: "goal_aborted"; goalId: string; reason: string; archivePath?: string; at: string }
  | { type: "task_list_set"; goalId: string; taskCount: number; blockCompletion: boolean; at: string }
  | { type: "task_complete"; goalId: string; taskId: string; evidence?: string; at: string }
  | { type: "task_skipped"; goalId: string; taskId: string; reason: string; at: string }
  | { type: "task_reopened"; goalId: string; taskId: string; at: string }
  | { type: "goal_budget_limited"; goalId: string; budget: number; tokensUsed: number; at: string }
  | { type: "goal_blocked"; goalId: string; reason: string; source: "agent" | "system"; at: string };

export interface GoalLedgerContext {
  cwd: string;
}

export interface GoalLedgerReadResult {
  events: GoalLedgerEvent[];
  malformed: number;
}

export interface ReconstructedGoalState {
  goalId: string;
  latestStatus: "active" | "paused" | "complete" | "aborted" | "unknown";
  latestFocus: boolean;
  latestPauseReason?: string;
  latestPauseSuggestedAction?: string;
  latestAuditorResult?: { verdict: "approved" | "disapproved" | "error"; report: string; at: string };
  createdAt?: string;
  completedAt?: string;
  abortedAt?: string;
  tweakedAt?: string;
  resumedAt?: string;
}

export interface ReconstructedLedgerState {
  focusedGoalId: string | null;
  goals: Map<string, ReconstructedGoalState>;
  terminalGoals: Map<string, ReconstructedGoalState>;
}

function safeGoalId(value: string): string {
  return safeIdPart(value);
}

export function goalLedgerPath(ctx: GoalLedgerContext): string {
  return path.resolve(ctx.cwd, normalizeRelPath(GOAL_LEDGER_FILE));
}

export type GoalLedgerAppendResult = { ok: true } | { ok: false; error: unknown };

/**
 * Append one ledger event. Returns a discriminated result instead of swallowing
 * both append attempts internally: the authoritative state write is never
 * rolled back after a ledger failure, but callers (GoalService) route failures
 * through the onDiagnostic hook so they stay observable.
 */
export function appendGoalEvent(ctx: GoalLedgerContext, event: GoalLedgerEvent): GoalLedgerAppendResult {
  const filePath = goalLedgerPath(ctx);
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: err };
  }

  const line = JSON.stringify(event) + "\n";
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let appended = false;
  try {
    fs.writeFileSync(tempPath, line, { flag: "wx", encoding: "utf8" });
    fs.appendFileSync(filePath, fs.readFileSync(tempPath, "utf8"), "utf8");
    appended = true;
  } catch (err) {
    // If temp write fails, try direct append as fallback.
    if (!appended) {
      try {
        fs.appendFileSync(filePath, line, "utf8");
        appended = true;
      } catch (fallbackErr) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Temp file may not exist; ignore cleanup failure.
        }
        return { ok: false, error: fallbackErr };
      }
    }
  } finally {
    if (appended) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Temp file may not exist; ignore cleanup failure.
      }
    }
  }
  return { ok: true };
}

export function readGoalLedger(ctx: GoalLedgerContext): GoalLedgerReadResult {
  const filePath = goalLedgerPath(ctx);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return { events: [], malformed: 0 };
  }

  const events: GoalLedgerEvent[] = [];
  let malformed = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isValidLedgerEvent(parsed)) {
        events.push(sanitizeEvent(parsed));
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

function isValidLedgerEvent(value: unknown): value is GoalLedgerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") return false;
  if (typeof obj.at !== "string") return false;
  const type = obj.type as GoalLedgerEvent["type"];
  switch (type) {
    case "goal_created":
      return typeof obj.goalId === "string" && typeof obj.objective === "string" && typeof obj.sisyphus === "boolean" && typeof obj.autoContinue === "boolean";
    case "goal_focused":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_unfocused":
      return typeof obj.reason === "string";
    case "goal_paused":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.suggestedAction === undefined || typeof obj.suggestedAction === "string") && (obj.status === undefined || obj.status === "paused");
    case "goal_resumed":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_tweaked":
      return typeof obj.goalId === "string" && typeof obj.changeSummary === "string";
    case "completion_requested":
      return typeof obj.goalId === "string" && (obj.summary === undefined || typeof obj.summary === "string");
    case "audit_started":
      return typeof obj.goalId === "string" && (obj.provider === undefined || typeof obj.provider === "string") && (obj.model === undefined || typeof obj.model === "string") && (obj.thinkingLevel === undefined || typeof obj.thinkingLevel === "string");
    case "audit_result":
      return typeof obj.goalId === "string" && (obj.verdict === "approved" || obj.verdict === "disapproved" || obj.verdict === "error") && typeof obj.report === "string";
    case "audit_skipped":
      return typeof obj.goalId === "string" && (obj.reason === "disabled" || obj.reason === "user_aborted") && (obj.provider === undefined || typeof obj.provider === "string") && (obj.model === undefined || typeof obj.model === "string") && (obj.thinkingLevel === undefined || typeof obj.thinkingLevel === "string");
    case "goal_completed":
      return typeof obj.goalId === "string" && (obj.archivePath === undefined || typeof obj.archivePath === "string");
    case "goal_aborted":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.archivePath === undefined || typeof obj.archivePath === "string");
    case "task_list_set":
      return typeof obj.goalId === "string" && typeof obj.taskCount === "number" && typeof obj.blockCompletion === "boolean";
    case "task_complete":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string" && (obj.evidence === undefined || typeof obj.evidence === "string");
    case "task_skipped":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string" && typeof obj.reason === "string";
    case "task_reopened":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string";
    case "goal_budget_limited":
      return typeof obj.goalId === "string" && typeof obj.budget === "number" && typeof obj.tokensUsed === "number";
    case "goal_blocked":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.source === "agent" || obj.source === "system");
    default:
      return false;
  }
}

function sanitizeEvent(event: GoalLedgerEvent): GoalLedgerEvent {
  switch (event.type) {
    case "goal_created":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_focused":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_paused":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_resumed":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_tweaked":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "completion_requested":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "audit_started":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "audit_result":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "audit_skipped":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_completed":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_aborted":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "task_list_set":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "task_complete":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "task_skipped":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "task_reopened":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_budget_limited":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_blocked":
      return { ...event, goalId: safeGoalId(event.goalId) };
    case "goal_unfocused":
      return event;
  }
}

export function reconstructGoalLedger(events: GoalLedgerEvent[]): ReconstructedLedgerState {
  const goals = new Map<string, ReconstructedGoalState>();
  const terminalGoals = new Map<string, ReconstructedGoalState>();
  let focusedGoalId: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case "goal_created": {
        const state: ReconstructedGoalState = {
          goalId: event.goalId,
          latestStatus: "active",
          latestFocus: false,
          createdAt: event.at,
        };
        goals.set(event.goalId, state);
        break;
      }
      case "goal_focused": {
        focusedGoalId = event.goalId;
        for (const g of goals.values()) g.latestFocus = false;
        for (const g of terminalGoals.values()) g.latestFocus = false;
        const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
        if (state) state.latestFocus = true;
        break;
      }
      case "goal_unfocused": {
        focusedGoalId = null;
        for (const g of goals.values()) g.latestFocus = false;
        for (const g of terminalGoals.values()) g.latestFocus = false;
        break;
      }
      case "goal_paused": {
        const state = goals.get(event.goalId);
        if (state) {
          state.latestStatus = event.status ?? "paused";
          state.latestPauseReason = event.reason;
          state.latestPauseSuggestedAction = event.suggestedAction;
        }
        break;
      }
      case "goal_resumed": {
        const state = goals.get(event.goalId);
        if (state) {
          state.latestStatus = "active";
          state.resumedAt = event.at;
          delete state.latestPauseReason;
          delete state.latestPauseSuggestedAction;
        }
        break;
      }
      case "goal_tweaked": {
        const state = goals.get(event.goalId);
        if (state) state.tweakedAt = event.at;
        break;
      }
      case "completion_requested": {
        // No status change until audit_result or goal_completed
        break;
      }
      case "audit_started": {
        // No state change
        break;
      }
      case "audit_skipped": {
        // audit was skipped; goal continues as-is
        break;
      }
      case "audit_result": {
        const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
        if (state) {
          state.latestAuditorResult = { verdict: event.verdict, report: event.report, at: event.at };
        }
        break;
      }
      case "goal_completed": {
        let state = goals.get(event.goalId);
        if (!state) {
          state = { goalId: event.goalId, latestStatus: "complete", latestFocus: false };        }
        state.latestStatus = "complete";
        state.completedAt = event.at;
        terminalGoals.set(event.goalId, state);
        goals.delete(event.goalId);
        break;
      }
      case "goal_aborted": {
        let state = goals.get(event.goalId);
        if (!state) {
          state = { goalId: event.goalId, latestStatus: "aborted", latestFocus: false };        }
        state.latestStatus = "aborted";
        state.abortedAt = event.at;
        terminalGoals.set(event.goalId, state);
        goals.delete(event.goalId);
        break;
      }
    }
  }

  // If the focused goal was moved to terminal (e.g., aborted/completed), clear focus.
  if (focusedGoalId && !goals.has(focusedGoalId)) {
    focusedGoalId = null;
  }

  return { focusedGoalId, goals, terminalGoals };
}

export function latestAuditorResultForGoal(events: GoalLedgerEvent[], goalId: string): { verdict: "approved" | "disapproved" | "error"; report: string; at: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "audit_result" && event.goalId === goalId) {
      return { verdict: event.verdict, report: event.report, at: event.at };
    }
  }
  return undefined;
}

export function latestEventsForGoal(events: GoalLedgerEvent[], goalId: string, limit = 10): GoalLedgerEvent[] {
  const result: GoalLedgerEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if ("goalId" in event && event.goalId === goalId) {
      result.unshift(event);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function latestGoalLifecycleEvent(events: GoalLedgerEvent[], goalId: string): GoalLedgerEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if ("goalId" in event && event.goalId === goalId) {
      return event;
    }
  }
  return undefined;
}
