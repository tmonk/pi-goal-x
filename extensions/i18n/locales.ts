/**
 * Registered translations. To add a language, create `locales/<code>.ts` that
 * default-exports a `Catalog`, then register it here. English needs no entry.
 */
import { registerLocale, setLocale, type Catalog } from "./index.ts";

/** Locale code -> catalog. Empty until a community translation is added. */
export const LOCALES: Record<string, Catalog> = {};

/** Registers every bundled catalog and switches to `code` (English when unset or unknown). */
export function configureLocale(code: string | undefined): void {
	for (const [name, catalog] of Object.entries(LOCALES)) registerLocale(name, catalog);
	setLocale(code);
}
