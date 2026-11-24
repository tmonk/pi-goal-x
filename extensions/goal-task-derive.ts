/**
 * F2: objective→task bootstrap. When a goal is created with no task list and
 * the objective contains an ordered-step or checklist structure, derive a
 * proposed task tree so goals start with a trackable, human-approved plan
 * instead of a blank checklist.
 */

import type { GoalTask } from "./goal-record.ts";

/**
 * Derive a proposed task tree from an objective's structure:
 *   - checklist markers: `- [ ] title` / `[ ] title`
 *   - ordered steps: `N. title`, `N) title`, `N: title` (≥2 items)
 * Returns null when the objective has no usable structure (the agent then
 * proposes tasks conversationally via set_goal_tasks).
 */
export function deriveTasksFromObjective(objective: string): GoalTask[] | null {
	const tasks: GoalTask[] = [];
	let sawChecklist = false;

	for (const raw of objective.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		// Checklist markers are the strongest signal.
		const checklist = line.match(/^(?:-\s*)?\[\s\]\s+(.+)$/);
		if (checklist) {
			sawChecklist = true;
			tasks.push({ id: `step-${tasks.length + 1}`, title: checklist[1]!.trim(), status: "pending" });
			continue;
		}
		// Ordered steps at line starts.
		const numbered = line.match(/^(\d{1,2})\s*[.):]\s+(.+)$/);
		if (numbered) {
			tasks.push({ id: `step-${tasks.length + 1}`, title: numbered[2]!.trim(), status: "pending" });
		}
	}

	if (tasks.length === 0) return null;
	if (!sawChecklist && tasks.length < 2) return null; // a lone numbered line is usually a section label
	return tasks;
}

