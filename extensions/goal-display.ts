export interface GoalUsageLike {
	tokensUsed: number;
	activeSeconds: number;
}

export interface GoalDisplayRecordLike {
	objective: string;
	status: "active" | "paused" | "blocked" | "budget_limited" | "complete";
	autoContinue: boolean;
	usage: GoalUsageLike;
	sisyphus: boolean;
	stopReason?: "user" | "agent";
}



export function truncateText(value: string, max = 120): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

export function displayObjectiveTitle(objective: string): string {
	const lines = objective.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
	const sectionHeader = /^(success criteria|boundaries|constraints|steps|order rules|don'ts|if blocked|if blocked \/ unclear \/ failing|sisyphus reminder)\s*[:：]/i;
	for (const line of lines) {
		if (/^=+\s*(?:sisyphus\s+)?goal\s*=+$/i.test(line)) continue;
		const objectiveMatch = line.match(/^(?:objective|目标)\s*[:：]\s*(.+)$/i);
		if (objectiveMatch?.[1]) return objectiveMatch[1].trim();
		if (sectionHeader.test(line)) continue;
		return line;
	}
	return truncateText(objective);
}

export function formatTokenValue(value: number): string {
	const safe = Math.max(0, Math.floor(value));
	const compact =
		safe >= 1_000_000_000
			? `${(safe / 1_000_000_000).toFixed(safe >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, "")}B`
			: safe >= 1_000_000
				? `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`
				: safe >= 10_000
					? `${(safe / 1_000).toFixed(0)}K`
					: safe >= 1_000
						? `${(safe / 1_000).toFixed(1).replace(/\.0$/, "")}K`
						: String(safe);
	const exact = safe.toLocaleString("en-US");
	if (compact === exact) return `${exact} tokens`;
	return `${compact} (${exact}) tokens`;
}

export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m${secs.toString().padStart(2, "0")}s`;
	if (minutes > 0) return `${minutes}m${secs.toString().padStart(2, "0")}s`;
	return `${secs}s`;
}

export function statusLabel(goal: Pick<GoalDisplayRecordLike, "sisyphus" | "status" | "autoContinue" | "stopReason">): string {
	const prefix = goal.sisyphus ? "sisyphus " : "";
	if (goal.status === "active" && goal.autoContinue) return `${prefix}running`;
	if (goal.status === "paused" && goal.stopReason === "agent") return `${prefix}paused (agent)`;
	if (goal.status === "blocked") return `${prefix}blocked`;
	if (goal.status === "budget_limited") return `${prefix}budget limited`;
	return `${prefix}${goal.status}`;
}

export function footerStatus(goal: GoalDisplayRecordLike): string {
	const usageBits: string[] = [];
	if (goal.usage.activeSeconds > 0) usageBits.push(formatDuration(goal.usage.activeSeconds));
	if (goal.usage.tokensUsed > 0) usageBits.push(formatTokenValue(goal.usage.tokensUsed).split(" ")[0]!);
	const usage = usageBits.length > 0 ? ` [${usageBits.join(" ")}]` : "";
	const prefix = goal.sisyphus ? "goal✊" : "goal";
	return `${prefix}: ${statusLabel(goal)}${usage} - ${truncateText(goal.objective, 60)}`;
}
