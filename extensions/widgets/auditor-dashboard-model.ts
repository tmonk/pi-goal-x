/**
 * Structured audit dashboard model (plan §15).
 *
 * Pure derivation from the low-level auditor progress stream: five check
 * stages (objective, verification, tasks, workspace, decision) with explicit
 * pending/running/passed/failed states, plus the approval/rejection result
 * card model. No TUI imports; the renderer and /goal-status share this model.
 */

import type { AuditorProgress } from "../goal-auditor.ts";

type AuditCheckState = "pending" | "running" | "passed" | "failed";

type AuditCheckId = "objective" | "verification" | "tasks" | "workspace" | "decision";

export interface AuditCheck {
	id: AuditCheckId;
	label: string;
	state: AuditCheckState;
	detail?: string;
}

export type AuditVerdict = "approved" | "disapproved" | "error";

export interface AuditorDashboardModel {
	auditorLabel: string;
	elapsedMs: number;
	percentage?: number;
	checks: AuditCheck[];
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput: string[];
	/** Result verdict when the audit finished (drives the result card). */
	verdict?: AuditVerdict | null;
	/** Whether the audit session is still running (false when phase === done). */
	active: boolean;
}

export interface AuditResultCard {
	verdict: AuditVerdict;
	label: string;
	lines: string[];
}

const CHECK_LABELS: Array<{ id: AuditCheckId; label: string }> = [
	{ id: "objective", label: "Objective and success criteria" },
	{ id: "verification", label: "Verification contracts" },
	{ id: "tasks", label: "Tasks and recorded evidence" },
	{ id: "workspace", label: "Workspace inspection" },
	{ id: "decision", label: "Final decision" },
];

interface DeriveAuditorDashboardOptions {
	auditorLabel?: string;
	/** Result verdict when known (set after the audit session finishes). */
	verdict?: AuditVerdict | null;
}

/**
 * Derive the structured audit dashboard from the raw progress stream (§15.2).
 *
 * Active audit: checks advance through percentage bands (objective ≥20%,
 * verification ≥40%, tasks ≥60%, workspace ≥80%, decision ≥80%) so the five
 * stages light up in order. Finished audit: all checks pass except decision,
 * which follows the verdict (approved → passed; disapproved/error → failed).
 */
export function deriveAuditorDashboardModel(
	progress: AuditorProgress,
	options: DeriveAuditorDashboardOptions = {},
): AuditorDashboardModel {
	const pct = clampPercentage(progress.percentage);
	const done = progress.phase === "done";
	const verdict = options.verdict !== undefined ? options.verdict : null;

	const checks: AuditCheck[] = CHECK_LABELS.map(({ id, label }) => {
		if (!done) {
			const state = checkStateActive(id, pct);
			return { id, label, state };
		}
		if (id === "decision") {
			const state: AuditCheckState = verdict === "approved" ? "passed" : verdict === "disapproved" || verdict === "error" ? "failed" : "passed";
			return { id, label, state };
		}
		return { id, label, state: "passed" };
	});

	return {
		auditorLabel: options.auditorLabel ?? progress.label ?? "Independent completion audit",
		elapsedMs: progress.elapsedMs,
		...(progress.percentage !== undefined ? { percentage: pct } : {}),
		checks,
		currentTool: progress.currentTool,
		currentToolArgs: progress.currentToolArgs,
		recentOutput: progress.recentOutput,
		...(verdict ? { verdict } : {}),
		active: !done,
	};
}

function checkStateActive(id: AuditCheckId, pct: number): AuditCheckState {
	switch (id) {
		case "objective":
			return pct >= 20 ? "passed" : "running";
		case "verification":
			return pct >= 40 ? "passed" : pct >= 20 ? "running" : "pending";
		case "tasks":
			return pct >= 60 ? "passed" : pct >= 40 ? "running" : "pending";
		case "workspace":
			return pct >= 80 ? "passed" : pct >= 60 ? "running" : "pending";
		case "decision":
			return pct >= 80 ? "running" : "pending";
	}
}

function clampPercentage(value: number | undefined): number {
	if (value === undefined) return 0;
	return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Build the result card (§15.4). Approval shows the fixed acceptance lines;
 * rejection extracts concise findings from the auditor report (bullet-style or
 * the leading non-marker lines, capped at three); errors state the failure.
 */
export function deriveAuditResultCard(verdict: AuditVerdict, report: string): AuditResultCard {
	if (verdict === "approved") {
		return {
			verdict,
			label: "APPROVED",
			lines: ["Objective satisfied.", "Verification requirements satisfied.", "Required tasks and evidence accepted."],
		};
	}
	if (verdict === "error") {
		return {
			verdict,
			label: "ERROR",
			lines: [report.trim() ? oneLine(report) : "The auditor could not finish the review."],
		};
	}
	const findings = extractFindings(report);
	return {
		verdict,
		label: "CHANGES REQUIRED",
		lines: findings.length > 0 ? findings : [oneLine(report) || "The auditor requested changes — review the report."],
	};
}

function extractFindings(report: string): string[] {
	const lines = report.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const findings: string[] = [];
	for (const line of lines) {
		if (/^<(approved|disapproved)\s*\/>/.test(line)) continue;
		const cleaned = line.replace(/^[-*•✗✓]\s*/, "").replace(/^(\d+[.)])\s*/, "").trim();
		if (!cleaned) continue;
		// Skip section headers ("Audit report:", "Findings:") and generic
		// "Auditor: ..." attribution lines — they are not findings.
		if (/^auditor\s*:/i.test(cleaned)) continue;
		if (/^[a-z][a-z ]{0,24}:$/i.test(cleaned)) continue;
		if (cleaned.length > 200) findings.push(`${cleaned.slice(0, 197)}...`);
		else findings.push(cleaned);
		if (findings.length >= 3) break;
	}
	return findings;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
