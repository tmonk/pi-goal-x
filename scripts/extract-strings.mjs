// Lists every string passed to t() / tn() so a translator can start from the full set.
// Usage: node scripts/extract-strings.mjs [--json]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extensions");
const T_CALL = /\bt\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const TN_CALL = /\btn\([^,]+,\s*\{\s*one:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*other:\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/g;

export function extractStrings() {
	const found = new Map();
	const add = (text, file) => found.set(text, [...(found.get(text) ?? []), file]);
	for (const name of readdirSync(root, { recursive: true })) {
		if (!String(name).endsWith(".ts") || String(name).startsWith("i18n")) continue;
		const source = readFileSync(path.join(root, String(name)), "utf8");
		for (const match of source.matchAll(T_CALL)) add(match[2], String(name));
		for (const match of source.matchAll(TN_CALL)) add(match[4], String(name));
	}
	return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const strings = [...extractStrings().keys()].sort();
	console.log(process.argv.includes("--json") ? JSON.stringify(Object.fromEntries(strings.map((s) => [s, s])), null, 2) : strings.join("\n"));
}
