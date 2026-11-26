import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractVerifyCommand, isVerifyCommandTrusted, runVerifyCommand, trustVerifyCommand } from "../extensions/goal-verify-command.ts";
import { extractVerificationContract } from "../extensions/goal-contract.ts";
import { stabilizationHarness } from "./support/stabilization-utils.ts";

function withAgentDir<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
	const dir = mkdtempSync(path.join(tmpdir(), "goal-verify-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	return Promise.resolve(run(dir)).finally(() => {
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
		rmSync(dir, { recursive: true, force: true });
	});
}

test("verify command: kept when it is written inline on a one-line /goal-direct objective", () => {
	const { verificationContract } = extractVerificationContract("Fix add.js. Verification contract: tests pass. Verify command: `npm test`");
	assert.equal(extractVerifyCommand(verificationContract), "npm test");
	assert.equal(extractVerificationContract("Fix add.js").verificationContract, undefined);
});

test("verify command: read from a backtick-quoted line in the contract", () => {
	assert.equal(extractVerifyCommand("Tests pass. Verify command: `npm test`"), "npm test");
	assert.equal(extractVerifyCommand("verify command: `node -e \"process.exit(0)\"` and more"), "node -e \"process.exit(0)\"");
	assert.equal(extractVerifyCommand("Run npm test"), undefined);
	assert.equal(extractVerifyCommand("Verify command: npm test"), undefined, "no backticks, no command");
	assert.equal(extractVerifyCommand(undefined), undefined);
});

test("verify command: trust is per project and per command, and lives outside the project", () => withAgentDir(() => {
	const cwd = path.join(tmpdir(), "project-a");
	assert.equal(isVerifyCommandTrusted(cwd, "npm test"), false);
	trustVerifyCommand(cwd, "Verify command: `npm test`");
	assert.equal(isVerifyCommandTrusted(cwd, "npm test"), true);
	assert.equal(isVerifyCommandTrusted(cwd, "npm run other"), false);
	assert.equal(isVerifyCommandTrusted(path.join(tmpdir(), "project-b"), "npm test"), false);
	trustVerifyCommand(cwd, "no command here");
}));

test("verify command: runs in the project folder and reports exit code and the output tail", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-verify-run-"));
	try {
		const pass = await runVerifyCommand(cwd, `node -e "console.log(process.cwd())"`);
		assert.equal(pass.ok, true);
		assert.match(pass.output, /goal-verify-run-/);
		const fail = await runVerifyCommand(cwd, `node -e "console.error('boom'); process.exit(3)"`);
		assert.equal(fail.ok, false);
		assert.equal(fail.exitCode, 3);
		assert.match(fail.output, /boom/);
		const noisy = await runVerifyCommand(cwd, `node -e "process.stdout.write('x'.repeat(100000) + 'END')"`);
		assert.ok(noisy.output.length <= 2000 && noisy.output.endsWith("END"), "only the tail is kept");
		const slow = await runVerifyCommand(cwd, `node -e "setTimeout(()=>{}, 10000)"`, 200);
		assert.equal(slow.timedOut, true);
		assert.equal(slow.ok, false);
		const missing = await runVerifyCommand(cwd, "definitely-not-a-command-xyz");
		assert.equal(missing.ok, false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

async function complete(command: string, trust: boolean, auditor: (...args: any[]) => Promise<any>) {
	return withAgentDir(async () => {
		const h = stabilizationHarness(auditor);
		try {
			await h.start();
			const contract = `Output is correct. Verify command: \`${command}\``;
			h.core.state.goal!.verificationContract = contract;
			if (trust) trustVerifyCommand(h.cwd, contract);
			const result = await h.call("update_goal", { status: "complete" });
			return { text: String((result.content?.[0] as any)?.text ?? ""), status: h.core.state.goal?.status, notices: [...h.notices] };
		} finally { await h.cleanup(); }
	});
}

test("completion: a failing trusted verify command rejects without calling the auditor", async () => {
	let audits = 0;
	const out = await complete(`node -e "console.log('3 tests failed'); process.exit(1)"`, true, async () => { audits++; return { approved: true, output: "<approved/>" }; });
	assert.equal(audits, 0);
	assert.match(out.text, /verify command .* exited with code 1/);
	assert.match(out.text, /3 tests failed/);
	assert.notEqual(out.status, "complete");
});

test("completion: a passing trusted verify command goes on to the auditor and hands it the output", async () => {
	let warm = "";
	const out = await complete(`node -e "console.log('all green')"`, true, async (args: any) => { warm = args.warmContext ?? ""; return { approved: true, output: "<approved/>", model: "fixture" }; });
	assert.match(warm, /passed \(exit 0\)/);
	assert.match(warm, /all green/);
	assert.equal(out.status, "complete");
});

test("completion: an untrusted verify command is never run, and the user is told", async () => {
	const marker = path.join(tmpdir(), `verify-ran-${process.pid}`);
	let audits = 0;
	const out = await complete(`node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`, false, async () => { audits++; return { approved: true, output: "<approved/>", model: "fixture" }; });
	assert.equal(audits, 1, "the audit still happens");
	assert.ok(out.notices.some(n => /not confirmed on this machine/.test(n)));
	assert.equal((await import("node:fs")).existsSync(marker), false, "the command did not run");
});
