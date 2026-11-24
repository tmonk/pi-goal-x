import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { registerLocale, setLocale } from "../extensions/i18n/index.ts";
import { effectiveSettingsReport } from "../extensions/settings/resolve.ts";
import { buildAuditorModelChoices } from "../extensions/auditor-selector.ts";

afterEach(() => setLocale("en"));

test("the settings report and auditor choices use the active locale", () => {
	registerLocale("xx", { "Settings (provenance):": "XX settings", "✎ Enter provider/model manually (advanced)": "XX manual" });
	assert.equal(effectiveSettingsReport(process.cwd())[0], "Settings (provenance):");
	assert.equal(buildAuditorModelChoices([], undefined, undefined).at(-1)?.label, "✎ Enter provider/model manually (advanced)");
	setLocale("xx");
	assert.equal(effectiveSettingsReport(process.cwd())[0], "XX settings");
	assert.equal(buildAuditorModelChoices([], undefined, undefined).at(-1)?.label, "XX manual");
});
