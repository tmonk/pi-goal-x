import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testsRoot = join(projectRoot, "tests");
const integrationRoot = join(testsRoot, "integration");
const e2eRoot = join(testsRoot, "e2e");
const manifestPath = join(testsRoot, ".test-manifest.json");
const suite = process.argv[2] ?? "unit";
const wantSelfCheck = process.argv.includes("--selfcheck");
const wantWriteManifest = process.argv.includes("--write-manifest");

function discover(directory) {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
		.map((entry) => join(directory, entry.name))
		.sort();
}

const unitFiles = discover(testsRoot);
const integrationFiles = discover(integrationRoot);
const e2eFiles = discover(e2eRoot);
const testFiles = suite === "integration"
	? integrationFiles
	: suite === "e2e"
		? e2eFiles
		: suite === "all"
			? [...unitFiles, ...integrationFiles, ...e2eFiles]
			: unitFiles;

if (testFiles.length === 0) {
	throw new Error("No " + suite + " test files were discovered.");
}

// Manifest entries are repo-relative and always forward-slashed, so the pinned
// entry list is identical on every platform that regenerates it.
const relativeEntry = (file) => file.replace(projectRoot, ".").replaceAll("\\", "/");

// ---- Self-check / manifest maintenance -------------------------------
// The manifest pins the EXPECTED discovered entries so drift (a new test
// file, a deleted one, or a directory change) is caught explicitly instead
// of silently changing what `npm test` covers.
if (wantWriteManifest) {
	writeFileSync(manifestPath, JSON.stringify({
		version: 1,
		note: "Expected test-entry manifest for the runner self-check (npm run test:selfcheck). Regenerate with: node scripts/run-unit-tests.mjs --write-manifest",
		unitFiles: unitFiles.map(relativeEntry),
		integrationFiles: integrationFiles.map(relativeEntry),
		e2eFiles: e2eFiles.map(relativeEntry),
	}, null, 2) + "\n");
	console.log("Wrote " + manifestPath + " (" + unitFiles.length + " unit, " + integrationFiles.length + " integration, " + e2eFiles.length + " e2e entries).");
	process.exit(0);
}

if (wantSelfCheck) {
	if (!existsSync(manifestPath)) {
		throw new Error("Missing " + manifestPath + ". Run: node scripts/run-unit-tests.mjs --write-manifest");
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const rel = relativeEntry;
	const expectedUnit = new Set(manifest.unitFiles ?? []);
	const expectedIntegration = new Set(manifest.integrationFiles ?? []);
	const expectedE2e = new Set(manifest.e2eFiles ?? []);
	const problems = [];
	for (const file of unitFiles) if (!expectedUnit.has(rel(file))) problems.push("unexpected unit entry: " + rel(file));
	for (const file of integrationFiles) if (!expectedIntegration.has(rel(file))) problems.push("unexpected integration entry: " + rel(file));
	for (const file of e2eFiles) if (!expectedE2e.has(rel(file))) problems.push("unexpected e2e entry: " + rel(file));
	for (const file of manifest.unitFiles ?? []) if (!unitFiles.map(rel).includes(file)) problems.push("missing unit entry: " + file);
	for (const file of manifest.integrationFiles ?? []) if (!integrationFiles.map(rel).includes(file)) problems.push("missing integration entry: " + file);
	for (const file of manifest.e2eFiles ?? []) if (!e2eFiles.map(rel).includes(file)) problems.push("missing e2e entry: " + file);
	if (problems.length > 0) {
		console.error("Runner self-check FAILED:");
		for (const problem of problems) console.error("  - " + problem);
		console.error("Refresh the manifest with: node scripts/run-unit-tests.mjs --write-manifest");
		process.exit(1);
	}
	console.log("Runner self-check OK: " + unitFiles.length + " unit + " + integrationFiles.length + " integration + " + e2eFiles.length + " e2e entries match " + manifestPath + ".");
}

// ---- Execution ---------------------------------------------------------
const startedAt = Date.now();
// `--test-isolation=none` (single-process suite, shared module state) is only
// accepted by Node >= 23.4; probe the running binary and omit it on older
// releases so the same script works across the supported Node range (22.15+).
const isolationProbe = spawnSync(process.execPath, ["--test-isolation=none", "--test", "--help"], { stdio: "ignore" });
const isolationArgs = isolationProbe.status === 0 ? ["--test-isolation=none"] : [];
const result = spawnSync(
	process.execPath,
	[
		"--import", pathToFileURL(join(projectRoot, "scripts", "test-adapter-hooks.mjs")).href,
		"--experimental-strip-types",
		"--test",
		...isolationArgs,
		...testFiles,
	],
	{ cwd: projectRoot, stdio: "inherit" },
);

const elapsedMs = Date.now() - startedAt;
console.log(`[runner] ${testFiles.length} test file(s) discovered; suite finished in ${elapsedMs} ms.`);
console.log("[runner] Timings are evidence on this machine, not machine-independent performance promises.");

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
