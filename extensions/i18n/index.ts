/**
 * Small translation layer. The English text is written at the call site and is
 * also the lookup key, so adding a feature in English needs no catalog change:
 *
 *   ctx.ui.notify(t("Goal paused."), "info");
 *   ctx.ui.notify(t("Budget {percent}% used", { percent }), "warning");
 *   tn(count, { one: "{n} task left", other: "{n} tasks left" });
 *
 * A translation is a catalog (English text -> translated text) registered
 * under a locale code in `locales/index.ts`. A missing entry falls back to the
 * English text, so a half-finished catalog still works.
 *
 * Only text a person reads in the host UI goes through `t`. Prompts, tool
 * descriptions and anything else the model sees stay English, because changing
 * them would change the model's behavior and break prompt caching.
 */

/** Values that can fill a `{name}` placeholder. */
export type Vars = Record<string, string | number>;

/** English text -> translation. Plural entries map the plural category to text. */
export type Catalog = Record<string, string | Partial<Record<Intl.LDMLPluralRule, string>>>;

const catalogs = new Map<string, Catalog>();
let activeLocale = "en";
let activeCatalog: Catalog | undefined;

/** Makes `code` (for example "zh-CN") available to `setLocale`. */
export function registerLocale(code: string, catalog: Catalog): void {
	catalogs.set(normalize(code), catalog);
	if (normalize(code) === normalize(activeLocale)) activeCatalog = catalog;
}

/**
 * Picks the language for the session. "zh-CN" tries "zh-cn" and then "zh".
 * Unknown or empty codes fall back to English.
 */
export function setLocale(code: string | undefined): void {
	const wanted = normalize(code ?? "en");
	const language = wanted.split("-")[0] ?? "en";
	activeCatalog = catalogs.get(wanted) ?? catalogs.get(language);
	activeLocale = activeCatalog ? wanted : "en";
}

export function currentLocale(): string {
	return activeLocale;
}

/** Translates `text` and fills in `{name}` placeholders. */
export function t(text: string, vars?: Vars): string {
	const entry = activeCatalog?.[text];
	return fill(typeof entry === "string" ? entry : text, vars);
}

/** Picks the right plural form for `count`. `{n}` is filled with the count. */
export function tn(count: number, forms: { one: string; other: string }, vars?: Vars): string {
	const category = new Intl.PluralRules(activeLocale).select(count);
	const entry = activeCatalog?.[forms.other];
	const translated = typeof entry === "object" ? entry[category] ?? entry.other : undefined;
	const text = translated ?? (count === 1 ? forms.one : forms.other);
	return fill(text, { n: count, ...vars });
}

function fill(text: string, vars: Vars | undefined): string {
	if (!vars) return text;
	return text.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
		const value = vars[name];
		return value === undefined ? placeholder : String(value);
	});
}

function normalize(code: string): string {
	return code.trim().replace(/_/g, "-").toLowerCase();
}
