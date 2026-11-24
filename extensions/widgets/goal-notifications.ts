import { displayObjectiveTitle, truncateText } from "../goal-display.ts";

export function buildGoalRunningNotification(args: { objective: string; sisyphus: boolean; autoContinue: boolean }): string {
	const icon = args.sisyphus ? "◆" : "●";
	const mode = args.sisyphus ? "Sisyphus" : "Goal";
	const title = truncateText(displayObjectiveTitle(args.objective), 92);
	const drive = args.autoContinue ? "auto-continue on" : "manual mode";
	return [`${icon} ${mode} running`, `├─ ⟡ ${title}`, `└─ ${drive}`].join("\n");
}
