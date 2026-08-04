/**
 * Auditor model/thinking selector helpers (ll01 cb6760b pattern).
 *
 * `/goal-settings` provider/model rows open a searchable selector: the
 * current-session/default choice (which clears the explicit provider/model),
 * authenticated models from the model registry (with a ✓ marker on the exact
 * current selection), and an advanced manual `provider/model` entry. The
 * thinking-level row offers the six levels or `(default)`.
 */

export type AuditorModelSummary = { provider: string; id: string; name?: string };

export type AuditorChoice =
	| { kind: "default"; label: string }
	| { kind: "model"; provider: string; model: string; label: string }
	| { kind: "manual"; label: string };

export const AUDITOR_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function auditorModelLabel(model: AuditorModelSummary): string {
	return `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}`;
}

/** `${provider}/${model}` key for the current configured model, if explicit. */
export function configuredAuditorModelKey(config: { provider?: string; model?: string }): string | undefined {
	return config.provider && config.model ? `${config.provider}/${config.model}` : undefined;
}

export function buildAuditorModelChoices(
	available: AuditorModelSummary[],
	configured: string | undefined,
	session: string | undefined,
): AuditorChoice[] {
	const models = available.slice().sort((a, b) => auditorModelLabel(a).localeCompare(auditorModelLabel(b)));
	return [
		{
			kind: "default",
			label: `${configured ? "  " : session ? "✓ " : "  "}Current session / default${session ? ` (${session})` : " (system default)"}`,
		},
		...models.map((model) => {
			const key = `${model.provider}/${model.id}`;
			return {
				kind: "model" as const,
				provider: model.provider,
				model: model.id,
				label: `${configured === key ? "✓ " : "  "}${auditorModelLabel(model)}`,
			};
		}),
		{ kind: "manual", label: "✎ Enter provider/model manually (advanced)" },
	];
}

export function filterAuditorModelChoices(choices: AuditorChoice[], filter: string): AuditorChoice[] {
	const normalized = filter.trim().toLowerCase();
	if (!normalized) return choices;
	return choices.filter(
		(choice) => choice.kind === "default" || choice.kind === "manual" || choice.label.toLowerCase().includes(normalized),
	);
}

export function parseManualAuditorModel(input: string): { provider: string; model: string } | { error: string } {
	const value = input.trim();
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		return { error: "Auditor model must use provider/model format; unavailable models will fail clearly at audit time." };
	}
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function thinkingLevelChoices(current: string | undefined): string[] {
	return ["(default)", ...AUDITOR_THINKING_LEVELS].map((level) => (level === current ? `✓ ${level}` : `  ${level}`));
}
