import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testsRoot = join(projectRoot, "tests");
const integrationRoot = join(testsRoot, "integration");
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
const testFiles = suite === "integration"
	? integrationFiles
	: suite === "all"
		? [...unitFiles, ...integrationFiles]
		: unitFiles;

if (testFiles.length === 0) {
	throw new Error("No " + suite + " test files were discovered.");
}

// ---- Self-check / manifest maintenance -------------------------------
// The manifest pins the EXPECTED discovered entries so drift (a new test
// file, a deleted one, or a directory change) is caught explicitly instead
// of silently changing what `npm test` covers.
if (wantWriteManifest) {
	writeFileSync(manifestPath, JSON.stringify({
		version: 1,
		note: "Expected test-entry manifest for the runner self-check (npm run test:selfcheck). Regenerate with: node scripts/run-unit-tests.mjs --write-manifest",
		unitFiles: unitFiles.map((file) => file.replace(projectRoot, ".")),
		integrationFiles: integrationFiles.map((file) => file.replace(projectRoot, ".")),
	}, null, 2) + "\n");
	console.log("Wrote " + manifestPath + " (" + unitFiles.length + " unit, " + integrationFiles.length + " integration entries).");
	process.exit(0);
}

if (wantSelfCheck) {
	if (!existsSync(manifestPath)) {
		throw new Error("Missing " + manifestPath + ". Run: node scripts/run-unit-tests.mjs --write-manifest");
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const rel = (file) => file.replace(projectRoot, ".");
	const expectedUnit = new Set(manifest.unitFiles ?? []);
	const expectedIntegration = new Set(manifest.integrationFiles ?? []);
	const problems = [];
	for (const file of unitFiles) if (!expectedUnit.has(rel(file))) problems.push("unexpected unit entry: " + rel(file));
	for (const file of integrationFiles) if (!expectedIntegration.has(rel(file))) problems.push("unexpected integration entry: " + rel(file));
	for (const file of manifest.unitFiles ?? []) if (!unitFiles.map(rel).includes(file)) problems.push("missing unit entry: " + file);
	for (const file of manifest.integrationFiles ?? []) if (!integrationFiles.map(rel).includes(file)) problems.push("missing integration entry: " + file);
	if (problems.length > 0) {
		console.error("Runner self-check FAILED:");
		for (const problem of problems) console.error("  - " + problem);
		console.error("Refresh the manifest with: node scripts/run-unit-tests.mjs --write-manifest");
		process.exit(1);
	}
	console.log("Runner self-check OK: " + unitFiles.length + " unit + " + integrationFiles.length + " integration entries match " + manifestPath + ".");
}

// ---- Execution ---------------------------------------------------------
const startedAt = Date.now();
const result = spawnSync(
	process.execPath,
	[
		"--import", join(projectRoot, "scripts", "test-adapter-hooks.mjs"),
		"--experimental-strip-types",
		"--test",
		"--test-isolation=none",
		...testFiles,
	],
	{ cwd: projectRoot, stdio: "inherit" },
);

const elapsedMs = Date.now() - startedAt;
console.log(`[runner] ${testFiles.length} test file(s) discovered; suite finished in ${elapsedMs} ms.`);
console.log("[runner] Timings are evidence on this machine, not machine-independent performance promises.");

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
