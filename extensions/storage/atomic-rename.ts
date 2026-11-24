import * as fs from "node:fs";
import * as path from "node:path";
import { sleepSync } from "./file-lock.ts";

interface RenameIO {
	renameSync(source: string, target: string): void;
	rename(source: string, target: string): Promise<void>;
	isDirectorySync(target: string): boolean;
	isDirectory(target: string): Promise<boolean>;
	sleepSync(ms: number): void;
	sleep(ms: number): Promise<void>;
}

const native: RenameIO = {
	renameSync: (source, target) => fs.renameSync(source, target),
	rename: (source, target) => fs.promises.rename(source, target),
	isDirectorySync: target => { try { return fs.lstatSync(target).isDirectory(); } catch { return false; } },
	isDirectory: async target => { try { return (await fs.promises.lstat(target)).isDirectory(); } catch { return false; } },
	sleepSync,
	sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};
const transient = new Set(["EPERM", "EACCES", "EBUSY"]);
// Existing critical writers are synchronous. Cap their added sleep at 75ms;
// asynchronous metadata writers can wait longer without blocking Pi's input.
const syncDelays = [5, 10, 20, 40];
const asyncDelays = [...syncDelays, 80, 160];

/** File replacement only: no destination deletion, no retries of ordinary permission errors on POSIX. */
export function atomicRenamer(platform = process.platform, io: RenameIO = native) {
	const retryable = (error: unknown) => platform === "win32" && transient.has((error as NodeJS.ErrnoException | null)?.code ?? "");
	return {
		renameSync(source: string, target: string): void {
			for (let attempt = 0; ; attempt++) {
				try { io.renameSync(source, target); return; }
				catch (error) {
					if (!retryable(error) || attempt >= syncDelays.length || io.isDirectorySync(target)) throw error;
					io.sleepSync(syncDelays[attempt]!);
				}
			}
		},
		async rename(source: string, target: string): Promise<void> {
			for (let attempt = 0; ; attempt++) {
				try { await io.rename(source, target); return; }
				catch (error) {
					if (!retryable(error) || attempt >= asyncDelays.length || await io.isDirectory(target)) throw error;
					await io.sleep(asyncDelays[attempt]!);
				}
			}
		},
	};
}

export const {renameSync: renameAtomicSync, rename: renameAtomic} = atomicRenamer();

interface AtomicWriteOptions {
	/** Mode for a new file. An existing file keeps its own permissions. */
	mode?: number;
	/** fsync the file and its directory before returning. */
	durable?: boolean;
	/** Message to throw when the target is a symlink (default names the target path). */
	symlinkMessage?: string;
}

function lstatIfPresent(target: string): fs.Stats | undefined {
	try { return fs.lstatSync(target); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function tempPathFor(target: string): string {
	return `${target}.${process.pid}.${Date.now()}.tmp`;
}

/**
 * Replace `target` atomically: write a temp file beside it (never reusing an
 * existing one), then rename it over the target. Readers observe either the
 * old or the new content, never a partial write. Symlink targets are refused.
 */
export function writeFileAtomicSync(target: string, content: string, options: AtomicWriteOptions = {}): void {
	const prior = lstatIfPresent(target);
	if (prior?.isSymbolicLink()) throw new Error(options.symlinkMessage ?? `Refusing to replace symlink: ${target}`);
	const mode = prior ? prior.mode & 0o777 : options.mode ?? 0o666;
	const temp = tempPathFor(target);
	let fd: number | undefined;
	let created = false;
	try {
		fd = fs.openSync(temp, "wx", mode);
		created = true;
		// open() applies the umask; a replacement must keep the prior permissions.
		if (prior && process.platform !== "win32" && (mode & process.umask())) fs.fchmodSync(fd, mode);
		fs.writeFileSync(fd, content, "utf8");
		if (options.durable) fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		renameAtomicSync(temp, target);
	} catch (error) {
		if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
		if (created) { try { fs.unlinkSync(temp); } catch { /* best effort */ } }
		throw error;
	}
	if (options.durable) fsyncDirectory(target);
}

/** Asynchronous counterpart for best-effort metadata (no mode or durability options). */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
	const temp = tempPathFor(target);
	await fs.promises.writeFile(temp, content, { encoding: "utf8", flag: "wx" });
	try { await renameAtomic(temp, target); }
	catch (error) { try { await fs.promises.unlink(temp); } catch { /* best effort */ } throw error; }
}

function fsyncDirectory(target: string): void {
	let fd: number | undefined;
	try {
		fd = fs.openSync(path.dirname(target), "r");
		fs.fsyncSync(fd);
	} catch { /* directory fsync is platform-dependent */ }
	finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } } }
}
