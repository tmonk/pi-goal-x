/**
 * Fake providers used to spot a guided draft by its tool list. The tool list
 * is now the same in every phase, so read the phase from the conversation:
 * a draft starts with the drafting prompt and ends when a proposal is
 * confirmed or cancelled.
 */
const STARTS = ["[GOAL CONFIRMATION", "[GOAL TWEAK DRAFT]"];
const ENDS = ["Goal created and focused", "Goal confirmed and created", "Goal tweak confirmed and applied", "Draft cancelled"];

export function draftInProgress(messages = []) {
	let open = false;
	for (const message of messages) {
		const text = JSON.stringify(message);
		if (STARTS.some((start) => text.includes(start))) open = true;
		else if (open && ENDS.some((end) => text.includes(end))) open = false;
	}
	return open;
}
