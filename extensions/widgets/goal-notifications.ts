import { t } from "../i18n/index.ts";
import { displayObjectiveTitle, truncateText } from "../goal-display.ts";

export function buildGoalRunningNotification(args: { objective: string; sisyphus: boolean; autoContinue: boolean }): string {
	const icon = args.sisyphus ? "◆" : "●";
	const heading = args.sisyphus ? t("Sisyphus running") : t("Goal running");
	const title = truncateText(displayObjectiveTitle(args.objective), 92);
	const drive = args.autoContinue ? t("auto-continue on") : t("manual mode");
	return [`${icon} ${heading}`, `├─ ⟡ ${title}`, `└─ ${drive}`].join("\n");
}
