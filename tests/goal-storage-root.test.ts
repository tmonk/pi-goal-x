import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGoalCore } from "../extensions/goal-state.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { invalidateGoalSettingsCache } from "../extensions/settings/files.ts";
import { loadGoalSettings } from "../extensions/settings/resolve.ts";
import { goalStorageRoot, goalStoragePath, goalStorageContext, goalPoolSnapshotPath } from "../extensions/storage/goal-root.ts";
import { writeActiveGoalFile, archiveGoalFile, readActiveGoalPool, invalidateGoalPoolCache } from "../extensions/storage/goal-files.ts";
import { appendGoalEvent, readGoalLedger } from "../extensions/goal-ledger.ts";
import { acquireGoalLock } from "../extensions/storage/goal-lock.ts";
import { runRecoveryReport } from "../extensions/goal-recovery.ts";

function fixture(t: test.TestContext) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-root-")));
	t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); invalidateGoalSettingsCache(); invalidateGoalPoolCache(); });
	const root = path.join(dir, "pool");
	const context = (name: string, configured: unknown = root) => {
		const cwd = path.join(dir, name);
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi/pi-goal-x-settings.json"), JSON.stringify(configured === undefined ? {} : { goalsRoot: configured }));
		invalidateGoalSettingsCache();
		return { cwd, sessionManager: { getSessionId: () => name } };
	};
	return { dir, root, context };
}

test("shared pool keeps goals, ledger, locks, archives and snapshots together", t => {
	const f = fixture(t), a = f.context("a"), b = f.context("b");
	const goal = writeActiveGoalFile(a, createGoal({ objective: "Shared work", autoContinue: true, sisyphus: false }));
	assert.equal(readActiveGoalPool(b).get(goal.id)?.objective, "Shared work");
	assert.equal(appendGoalEvent(a, { type: "goal_created", goalId: goal.id, objective: goal.objective, autoContinue: true, sisyphus: false, at: goal.createdAt }).ok, true);
	assert.equal((readGoalLedger(b).events[0] as { goalId: string }).goalId, goal.id);
	const lock = acquireGoalLock(a, goal.id);
	try {
		assert.throws(() => acquireGoalLock(b, goal.id, { attempts: 1, retryMs: 0 }), /lock/i);
		const worker = `import { acquireGoalLock } from ${JSON.stringify(new URL("../extensions/storage/goal-lock.ts", import.meta.url).href)};
		try { acquireGoalLock(JSON.parse(process.argv[1]), process.argv[2], { attempts: 1, retryMs: 0 }); process.exit(2); }
		catch (error) { if (!/lock/i.test(String(error))) throw error; }`;
		execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", worker, JSON.stringify(goalStorageContext(b)), goal.id]);
	} finally { lock.release(); }
	assert.ok(fs.existsSync(goalPoolSnapshotPath(a)));
	assert.ok(goalPoolSnapshotPath(a).startsWith(f.root + path.sep));
	assert.equal(runRecoveryReport(b).malformedGoalFiles.length, 0);
	archiveGoalFile(b, { ...goal, status: "complete" });
	assert.equal(readActiveGoalPool(a).size, 0);
	assert.equal(fs.readdirSync(path.join(f.root, "archived")).length, 1);
	assert.equal(fs.existsSync(path.join(a.cwd, ".pi/goals")), false);
	assert.equal(fs.existsSync(path.join(b.cwd, ".pi/goals")), false);
});

test("root is pinned per session and separate sessions can select different pools", t => {
	const f = fixture(t), a = f.context("a");
	const plain = goalStorageContext(a);
	const next = path.join(f.dir, "new-pool");
	f.context("a", next);
	assert.equal(goalStorageRoot(a), f.root);
	assert.equal(goalStorageRoot(plain), f.root);
	assert.equal(goalStorageRoot({ cwd: a.cwd, sessionManager: { getSessionId: () => "new" } }), next);
	fs.rmSync(f.root, { recursive: true });
	assert.throws(() => writeActiveGoalFile(a, createGoal({ objective: "Must not recreate", autoContinue: true, sisyphus: false })), /ENOENT/);
	assert.equal(fs.existsSync(f.root), false);
});

test("invalid roots and symlinked managed directories fail instead of falling back", t => {
	const f = fixture(t);
	for (const invalid of ["relative/path", "", 12]) assert.throws(() => goalStorageRoot(f.context(`invalid-${String(invalid).length}`, invalid)), /goalsRoot|PI_GOAL_ROOT/);
	const a = f.context("a");
	goalStorageRoot(a);
	assert.throws(() => goalStoragePath(a, ".pi/goals/../../escape"), /escapes/);
	const outside = path.join(f.dir, "outside"); fs.mkdirSync(outside);
	fs.symlinkSync(outside, path.join(f.root, "archived"));
	const goal = createGoal({ objective: "No escape", autoContinue: true, sisyphus: false });
	assert.throws(() => archiveGoalFile(a, goal), /symlink/);
	assert.deepEqual(fs.readdirSync(outside), []);
	fs.symlinkSync(outside, path.join(f.dir, "linked-root"));
	assert.throws(() => goalStorageRoot(f.context("linked", path.join(f.dir, "linked-root"))), /symlink/);
});

test("default paths stay compatible; root configuration honors environment precedence", t => {
	const f = fixture(t), a = f.context("default", null);
	fs.writeFileSync(path.join(a.cwd, ".pi/pi-goal-x-settings.json"), '{}'); invalidateGoalSettingsCache();
	assert.equal(goalStorageRoot(a), path.join(a.cwd, ".pi/goals"));
	assert.equal(goalPoolSnapshotPath(a), path.join(a.cwd, ".pi/.goals-pool-snapshot.json"));
	const b = f.context("configured");
	assert.equal(loadGoalSettings(b.cwd, { PI_GOAL_ROOT: "/env-pool" }).goalsRoot, "/env-pool");
	assert.equal(loadGoalSettings(b.cwd, {}).goalsRoot, f.root);
});


test("shared worktrees reject stale revisions and refresh the winning write", async t => {
	const f = fixture(t), a = f.context("writer-a"), b = f.context("writer-b");
	const goal = writeActiveGoalFile(a, createGoal({objective: "Shared initial", autoContinue: true, sisyphus: false}));
	const coreFor = async (storage: typeof a) => {
		const core = createGoalCore({getActiveTools: () => [], setActiveTools() {}, appendEntry() {}} as any);
		const ctx = {...storage, hasUI: false, ui: {setStatus() {}, setWidget() {}, notify() {}}, sessionManager: {...storage.sessionManager, getBranch: () => [{type: "custom", customType: "pi-goal-focus", data: {...goalFocusDetails(goal.id, "created"), storageRoot: f.root}}]}} as any;
		await core.loadState(ctx);
		return {core, ctx};
	};
	const first = await coreFor(a), second = await coreFor(b);
	assert.equal(first.core.state.goal?.id, goal.id);
	assert.equal(second.core.state.goal?.id, goal.id);
	const mutate = (objective: string) => ({reconcile: false, mutate: (g: typeof goal) => ({...g, objective})});
	assert.equal(first.core.goalService.apply(first.ctx, mutate("Winning edit")).ok, true);
	const stale = second.core.goalService.apply(second.ctx, mutate("Stale overwrite"));
	assert.equal(stale.ok, false);
	if (!stale.ok) assert.match(stale.message, /revision/i);
	invalidateGoalPoolCache();
	await second.core.loadState(second.ctx);
	assert.equal(second.core.state.goal?.objective, "Winning edit");
	assert.equal(second.core.goalService.apply(second.ctx, mutate("Fresh edit")).ok, true);
	assert.equal(readActiveGoalPool(a).get(goal.id)?.objective, "Fresh edit");
	fs.rmSync(f.root, {recursive: true});
	invalidateGoalPoolCache();
	assert.throws(() => readActiveGoalPool(a), /ENOENT/);
	assert.equal(fs.existsSync(f.root), false, "refresh does not recreate a missing pinned pool");
});
