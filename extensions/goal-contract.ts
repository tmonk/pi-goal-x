/**
 * Small record/input parser (Stage 5 of the hardening plan): verification
 * contract extraction and objective prompt-safety live here, outside the
 * (the historical goal-draft module was removed).
 */

const VERIFICATION_CONTRACT_RE = /^Verification contract:\s*(.+)$/im;

/**
 * Extract a `Verification contract:` section from a goal objective and return
 * the cleaned objective (without the contract section) and the contract text.
 *
 * The contract section is a single line matching:
 *   Verification contract: <text>
 *
 * It can appear anywhere in the objective, but by convention it goes after
 * the other sections (like Success criteria, Boundaries, Constraints).
 *
 * If no contract section is found, `verificationContract` is undefined.
 */
export function extractVerificationContract(objective: string): { objective: string; verificationContract?: string } {
	const lines = objective.replace(/\r/g, "").split("\n");
	let contract: string | undefined;
	const filtered: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		const m = VERIFICATION_CONTRACT_RE.exec(trimmed);
		if (m) {
			contract = m[1].trim();
			// Skip this line — don't add it to the cleaned objective
		} else {
			filtered.push(line);
		}
	}

	return {
		objective: filtered.join("\n"),
		verificationContract: contract || undefined,
	};
}

/** Escape untrusted-objective tags so injected objectives cannot break prompts. */
export function promptSafeObjective(objective: string): string {
	return objective.replace(/<\/?untrusted_objective>/gi, (tag) => tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}
