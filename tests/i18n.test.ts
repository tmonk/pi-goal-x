import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { registerLocale, setLocale, t, tn, currentLocale } from "../extensions/i18n/index.ts";

afterEach(() => setLocale("en"));

test("t returns the English text and fills placeholders", () => {
	assert.equal(t("Goal paused."), "Goal paused.");
	assert.equal(t("Budget {percent}% of {total}", { percent: 50, total: "10k" }), "Budget 50% of 10k");
	assert.equal(t("Keep {unknown} as is", { other: 1 }), "Keep {unknown} as is");
});

test("a registered catalog translates, and missing entries fall back to English", () => {
	registerLocale("xx", { "Goal paused.": "XX paused {n}" });
	setLocale("xx");
	assert.equal(t("Goal paused."), "XX paused {n}");
	assert.equal(t("Goal resumed."), "Goal resumed.");
});

test("a regional code falls back to its language, and unknown codes fall back to English", () => {
	registerLocale("yy", { Hello: "Hola" });
	setLocale("yy-ZZ");
	assert.equal(t("Hello"), "Hola");
	assert.equal(currentLocale(), "yy-zz");
	setLocale("nope");
	assert.equal(t("Hello"), "Hello");
	assert.equal(currentLocale(), "en");
});

test("tn picks the English form, and a catalog can give plural categories", () => {
	const forms = { one: "{n} task left", other: "{n} tasks left" };
	assert.equal(tn(1, forms), "1 task left");
	assert.equal(tn(3, forms), "3 tasks left");
	registerLocale("zz", { "{n} tasks left": { other: "{n} zz" } });
	setLocale("zz");
	assert.equal(tn(1, forms), "1 zz");
});
