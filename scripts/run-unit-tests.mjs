import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testsRoot = join(projectRoot, "tests");
const integrationRoot = join(testsRoot, "integration");
const suite = process.argv[2] ?? "unit";

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

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
