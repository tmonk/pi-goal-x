import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extensions");
const sources = (readdirSync(extensionsDir, { recursive: true }) as string[])
	.filter((name) => name.endsWith(".ts") && !name.startsWith("i18n"))
	.map((name) => ({ name, text: readFileSync(path.join(extensionsDir, name), "utf8") }));

test("t() takes a plain string literal so strings can be listed", () => {
	const bad: string[] = [];
	for (const { name, text } of sources) {
		for (const match of text.matchAll(/(?<![\w.])t\(\s*([^)]{0,60})/g)) {
			const argument = match[1] ?? "";
			const plain = /^(["'])/.test(argument) || /^`[^`$]*`/.test(argument);
			if (!plain) bad.push(`${name}: t(${argument}`);
		}
	}
	assert.deepEqual(bad, [], `t() needs a string literal as its first argument:\n${bad.join("\n")}`);
});

test("the string extractor finds strings passed to t()", async () => {
	const { extractStrings } = await import("../scripts/extract-strings.mjs");
	assert.ok(extractStrings() instanceof Map);
});
