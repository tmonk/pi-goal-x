import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAgentDir } from "./settings/files.ts";

/**
 * A goal can name a command that must pass before the auditor runs:
 *
 *   Verification contract: tests pass. Verify command: `npm test`
 *
 * The command is shell text from a goal file, so it only runs after the user
 * has seen it. Confirming a draft or a tweak, or typing /goal-direct, trusts
 * the command. The trust list lives in the user's agent folder, never in the
 * project, so a goal file that arrives with a repository cannot trust itself.
 */

const COMMAND_RE = /verify command:\s*`([^`\n]+)`/i;
export const VERIFY_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CHARS = 2000;

export function extractVerifyCommand(contract: string | undefined): string | undefined {
	const command = contract ? COMMAND_RE.exec(contract)?.[1]?.trim() : undefined;
	return command || undefined;
}

function trustFile(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(resolveAgentDir(env), "pi-goal-x-trusted-verify.json");
}

function trustKey(cwd: string, command: string): string {
	return createHash("sha256").update(`${path.resolve(cwd)}\0${command}`).digest("hex");
}

function readTrusted(): string[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(trustFile(), "utf8"));
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

export function isVerifyCommandTrusted(cwd: string, command: string): boolean {
	return readTrusted().includes(trustKey(cwd, command));
}

/** Remember that the user saw this command for this project. Failure to save only means it will not run. */
export function trustVerifyCommand(cwd: string, contract: string | undefined): void {
	const command = extractVerifyCommand(contract);
	if (!command) return;
	const key = trustKey(cwd, command);
	const trusted = readTrusted();
	if (trusted.includes(key)) return;
	try {
		const file = trustFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify([...trusted, key].slice(-200))}\n`, { mode: 0o600 });
	} catch {
		// Not saved: the command stays untrusted and is skipped.
	}
}

export interface VerifyResult {
	ok: boolean;
	exitCode: number | null;
	timedOut: boolean;
	/** The end of the combined output, capped. */
	output: string;
}

/** Run the command in the project folder. Only the tail of the output is kept. */
export function runVerifyCommand(cwd: string, command: string, timeoutMs = VERIFY_TIMEOUT_MS, signal?: AbortSignal): Promise<VerifyResult> {
	return new Promise(resolve => {
		let tail = "";
		let timedOut = false;
		const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const keep = (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS * 2); };
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		const stop = () => { child.kill("SIGKILL"); };
		const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
		signal?.addEventListener("abort", stop, { once: true });
		const finish = (exitCode: number | null) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stop);
			resolve({ ok: exitCode === 0 && !timedOut, exitCode, timedOut, output: tail.trim().slice(-OUTPUT_TAIL_CHARS) });
		};
		child.on("error", error => { tail += String(error); finish(null); });
		child.on("close", code => finish(code));
	});
}
