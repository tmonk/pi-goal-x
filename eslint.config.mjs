import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/** TypeScript sources indent with tabs; spaces stay allowed inside strings and block comments. */
const tabIndentation = {
	meta: { type: "layout", schema: [] },
	create(context) {
		const source = context.sourceCode;
		return {
			Program() {
				const exempt = new Set();
				const exemptSpan = (loc) => { for (let line = loc.start.line + 1; line <= loc.end.line; line++) exempt.add(line); };
				for (const token of source.ast.tokens) if (token.type === "Template" || token.type === "String") exemptSpan(token.loc);
				for (const comment of source.getAllComments()) if (comment.type === "Block") exemptSpan(comment.loc);
				source.lines.forEach((line, index) => {
					if (!exempt.has(index + 1) && /^\t* +\S/.test(line)) context.report({ loc: { line: index + 1, column: 0 }, message: "Indent with tabs." });
				});
			},
		};
	},
};

/**
 * Small lint gate (intentionally quiet):
 * - JS best-practice rules via eslint:recommended.
 * - tsc owns undefined-name / unused-symbol reporting with the configured
 *   strictness; the core no-unused-vars rule also misfires on TS
 *   interface-conformance parameters and re-exported symbols.
 * - no-regex-spaces is off: several test regexes deliberately match multiple
 *   literal spaces in rendered output.
 * - local/tab-indentation keeps TypeScript indentation consistent (tabs).
 * - no-explicit-any applies only to extensions/ (the shipped product); test
 *   scaffolding may use `as any` freely.
 */
export default tseslint.config(
	{ ignores: ["node_modules/**", "experiments/**", "specs/**", "docs/**", ".pi/**"] },
	js.configs.recommended,
	{
		files: ["**/*.ts"],
		plugins: { "@typescript-eslint": tseslint.plugin, local: { rules: { "tab-indentation": tabIndentation } } },
		languageOptions: {
			parser: tseslint.parser,
			ecmaVersion: 2022,
			sourceType: "module",
			globals: globals.node,
		},
		rules: {
			"no-undef": "off",
			"no-unused-vars": "off",
			"no-regex-spaces": "off",
			"no-empty": ["error", { allowEmptyCatch: true }],
			"local/tab-indentation": "error",
		},
	},
	{
		files: ["extensions/**/*.ts"],
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
		},
	},
	{
		files: ["**/*.mjs"],
		languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: globals.node },
		rules: {
			"no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		},
	},
);
