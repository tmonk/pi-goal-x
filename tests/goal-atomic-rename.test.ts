import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { atomicRenamer, renameAtomic, renameAtomicSync } from "../extensions/storage/atomic-rename.ts";
import { atomicWriteGoalFile } from "../extensions/storage/goal-files.ts";
import { tempDir } from "./support/fs.ts";

function simulated(code: string, failures = Infinity, directory = false) {
	let attempts = 0, inspections = 0;
	const sleeps: number[] = [];
	const error = Object.assign(new Error(code), {code});
	const rename = () => { attempts++; if (attempts <= failures) throw error; };
	const inspect = () => { inspections++; return directory; };
	return {error, sleeps, attempts: () => attempts, inspections: () => inspections, io: {
		renameSync: rename, rename: async () => rename(), isDirectorySync: inspect, isDirectory: async () => inspect(),
		sleepSync: (ms: number) => {sleeps.push(ms);}, sleep: async (ms: number) => {sleeps.push(ms);},
	}};
}

test("uncontended replacement performs one rename without metadata reads or sleeps", () => {
	const fixture = simulated("EPERM", 0);
	atomicRenamer("win32", fixture.io).renameSync("source", "target");
	assert.equal(fixture.attempts(), 1);
	assert.equal(fixture.inspections(), 0);
	assert.deepEqual(fixture.sleeps, []);
});

for (const code of ["EPERM", "EACCES", "EBUSY"]) test(`temporary Windows ${code} recovers synchronously and asynchronously`, async () => {
	for (const async of [false, true]) {
		const fixture = simulated(code, 2);
		const renamer = atomicRenamer("win32", fixture.io);
		if (async) await renamer.rename("source", "target"); else renamer.renameSync("source", "target");
		assert.equal(fixture.attempts(), 3);
		assert.equal(fixture.sleeps.length, 2);
	}
});

test("persistent Windows failures remain honest with a bounded delay", async () => {
	const sync = simulated("EPERM");
	assert.throws(() => atomicRenamer("win32", sync.io).renameSync("source", "target"), error => error === sync.error);
	assert.ok(sync.sleeps.reduce((a,b) => a+b, 0) <= 75);
	assert.ok(sync.attempts() <= 5);
	const async = simulated("EBUSY");
	await assert.rejects(atomicRenamer("win32", async.io).rename("source", "target"), error => error === async.error);
	assert.ok(async.sleeps.reduce((a,b) => a+b, 0) <= 315);
	assert.ok(async.attempts() <= 7);
});

for (const platform of ["linux", "darwin", "win32"] as const) test(`${platform}: permanent failures do not wait`, async () => {
	for (const code of platform === "win32" ? ["ENOENT", "ENOSPC", "EXDEV"] : ["EPERM", "EACCES", "EBUSY"]) {
		for (const async of [false, true]) {
			const fixture = simulated(code);
			const renamer = atomicRenamer(platform, fixture.io);
			if (async) await assert.rejects(renamer.rename("source", "target"), error => error === fixture.error);
			else assert.throws(() => renamer.renameSync("source", "target"), error => error === fixture.error);
			assert.equal(fixture.attempts(), 1);
			assert.deepEqual(fixture.sleeps, []);
		}
	}
});

test("a directory destination is a permanent Windows failure", async () => {
	for (const async of [false, true]) {
		const fixture = simulated("EPERM", Infinity, true);
		const renamer = atomicRenamer("win32", fixture.io);
		if (async) await assert.rejects(renamer.rename("source", "target")); else assert.throws(() => renamer.renameSync("source", "target"));
		assert.equal(fixture.attempts(), 1);
		assert.deepEqual(fixture.sleeps, []);
	}
});

test("native replacement preserves data and goal-file permissions; failed writes clean owned temps", async t => {
	const cwd = tempDir("goal-atomic-");
	t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
	const source = path.join(cwd, "source");
	const target = path.join(cwd, "target");
	fs.writeFileSync(source, "new"); fs.writeFileSync(target, "old");
	renameAtomicSync(source, target);
	assert.equal(fs.readFileSync(target, "utf8"), "new");
	fs.writeFileSync(source, "async");
	await renameAtomic(source, target);
	assert.equal(fs.readFileSync(target, "utf8"), "async");
	assert.equal(fs.existsSync(source), false);
	atomicWriteGoalFile({cwd}, ".pi/goals", ".pi/goals/goal.md", "original");
	const goal = path.join(cwd, ".pi/goals/goal.md");
	if (process.platform !== "win32") fs.chmodSync(goal, 0o600);
	atomicWriteGoalFile({cwd}, ".pi/goals", ".pi/goals/goal.md", "replacement");
	assert.equal(fs.readFileSync(goal, "utf8"), "replacement");
	if (process.platform !== "win32") assert.equal(fs.statSync(goal).mode & 0o777, 0o600);
	if (process.platform !== "win32") {
		fs.chmodSync(goal, 0o640);
		const priorMask = process.umask(0o077);
		try { atomicWriteGoalFile({cwd}, ".pi/goals", ".pi/goals/goal.md", "private replacement"); }
		finally { process.umask(priorMask); }
		assert.equal(fs.statSync(goal).mode & 0o777, 0o640, "replacement preserves existing permissions under a stricter umask");
	}
	fs.mkdirSync(path.join(cwd, ".pi/goals/directory.md"));
	assert.throws(() => atomicWriteGoalFile({cwd}, ".pi/goals", ".pi/goals/directory.md", "invalid"));
	assert.equal(fs.readdirSync(path.join(cwd, ".pi/goals")).some(name => name.endsWith(".tmp")), false);
});

test("a temporary-file collision does not delete someone else's file", t => {
	const cwd = tempDir("goal-atomic-collision-");
	t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
	fs.mkdirSync(path.join(cwd, ".pi/goals"), {recursive: true});
	t.mock.method(Date, "now", () => 1234);
	const temp = path.join(cwd, `.pi/goals/goal.md.${process.pid}.1234.tmp`);
	fs.writeFileSync(temp, "other writer");
	assert.throws(() => atomicWriteGoalFile({cwd}, ".pi/goals", ".pi/goals/goal.md", "replacement"));
	assert.equal(fs.readFileSync(temp, "utf8"), "other writer");
});
