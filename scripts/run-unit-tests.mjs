import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testsRoot = join(projectRoot, "tests");
const integrationRoot = join(testsRoot, "integration");
const e2eRoot = join(testsRoot, "e2e");
const manifestPath = join(testsRoot, ".test-manifest.json");
const suite = process.argv[2] ?? "unit";
const wantSelfCheck = process.argv.includes("--selfcheck");
const wantWriteManifest = process.argv.includes("--write-manifest");
// `--shard=1/2` runs half of the files; CI uses it to spread the suite over jobs.
const shard = process.argv.find((arg) => arg.startsWith("--shard="))?.slice("--shard=".length);
if (shard && !/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error("Bad --shard value: " + shard);
if (shard && Number(shard.split("/")[0]) > Number(shard.split("/")[1])) throw new Error("Bad --shard value: " + shard);

function discover(directory) {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
		.map((entry) => join(directory, entry.name))
		.sort();
}

const rel = (file) => "./" + relative(projectRoot, file).replaceAll("\\", "/");
const unitFiles = discover(testsRoot);
const integrationFiles = discover(integrationRoot);
const e2eFiles = discover(e2eRoot);
const testFiles = suite === "integration"
	? integrationFiles
	: suite === "e2e"
		? e2eFiles
		: suite === "all"
			// The slow end-to-end files go first so they overlap with the many quick ones.
			? [...e2eFiles, ...integrationFiles, ...unitFiles]
			: unitFiles;

// `--shard=1/4` runs a share of the files. Each file gets a rough cost (the two slowest files, then
// end-to-end, integration and unit files) and goes to the shard with the least work so far, so no
// shard is left holding all the slow ones. The shards together cover every file exactly once.
const SLOWEST = ["tests/e2e/goal-session-safety.test.ts", "tests/goal-cache-simulation.test.ts"];
function shardFiles(files, shardSpec) {
	if (!shardSpec) return files;
	const [index, count] = shardSpec.split("/").map(Number);
	const cost = (file) => {
		const name = rel(file).slice(2);
		return SLOWEST.includes(name) ? 8 : name.startsWith("tests/e2e/") ? 3 : name.startsWith("tests/integration/") ? 2 : 1;
	};
	const load = new Array(count).fill(0);
	const mine = [];
	for (const file of [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
		const target = load.indexOf(Math.min(...load));
		load[target] += cost(file);
		if (target === index - 1) mine.push(file);
	}
	return mine.sort();
}
const shardedFiles = shardFiles(testFiles, shard);

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
		unitFiles: unitFiles.map(rel),
		integrationFiles: integrationFiles.map(rel),
		e2eFiles: e2eFiles.map(rel),
	}, null, 2) + "\n");
	console.log("Wrote " + manifestPath + " (" + unitFiles.length + " unit, " + integrationFiles.length + " integration, " + e2eFiles.length + " e2e entries).");
	process.exit(0);
}

if (wantSelfCheck) {
	if (!existsSync(manifestPath)) {
		throw new Error("Missing " + manifestPath + ". Run: node scripts/run-unit-tests.mjs --write-manifest");
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	
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
const result = spawnSync(
	process.execPath,
	[
		// A file URL, not a path: Windows drive letters otherwise parse as URL schemes.
		"--import", pathToFileURL(join(projectRoot, "scripts", "test-adapter-hooks.mjs")).href,
		"--experimental-strip-types",
		"--test",
		...shardedFiles,
	],
	{ cwd: projectRoot, stdio: "inherit" },
);

const elapsedMs = Date.now() - startedAt;
console.log(`[runner] ${shardedFiles.length} of ${testFiles.length} test file(s) run; suite finished in ${elapsedMs} ms.`);
console.log("[runner] Timings are evidence on this machine, not machine-independent performance promises.");

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
