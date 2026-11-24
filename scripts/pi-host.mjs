/** Resolve probes against this checkout's SDK, independently of the global CLI. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
export const piPackageRoot = path.resolve(path.dirname(entry), "..");
const metadata = JSON.parse(readFileSync(path.join(piPackageRoot, "package.json"), "utf8"));
export const piVersion = metadata.version;
export const piCLI = path.resolve(piPackageRoot, typeof metadata.bin === "string" ? metadata.bin : metadata.bin.pi);

// CI cache probe: remove.
