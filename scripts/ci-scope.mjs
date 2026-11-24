/** Keep required jobs present, while avoiding runtime checks for prose/assets only. */
import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export function needsRuntimeChecks(files) {
 return files.length === 0 || files.some(file => !/^(README\.md|CHANGELOG\.md|LICENSE|(?:docs|specs|assets)\/.*|pi-goal-x\.png)$/.test(file));
}

const PROSE='README\\.md|CHANGELOG\\.md|LICENSE|(?:docs|specs|assets)\\/.*|pi-goal-x\\.png';
const TEST_FILES='tests\\/(?:.*\\/)?[^/]+\\.test\\.ts';
// CI scripts and their tests. Nothing the product or the heavy checks load.
const CI_TOOLING='scripts\\/(?:ci-checks|ci-scope|test-ci|test-publish-workflow|test-update-ranking|update-ranking|extract-strings)\\.[a-z]+';
const anyOutside=(files, safe) => files.length === 0 || files.some(file => !new RegExp(`^(?:${PROSE}|${safe})$`).test(file));

// The benchmark measures the extension. It loads tests/support and tests/stubs, but not test files,
// the walkthrough or the context checks.
export function needsBench(files) {
 return anyOutside(files, `${TEST_FILES}|${CI_TOOLING}|experiments\\/(?:controls|continuation|context)\\/.*`);
}

// The walkthrough drives the real Pi CLI with the extension. The benchmark and context checks do not touch it.
export function needsControls(files) {
 return anyOutside(files, `${TEST_FILES}|${CI_TOOLING}|experiments\\/(?:bench|context)\\/.*`);
}

export function changedFiles(base, cwd=process.cwd()) {
 if(!/^[a-f0-9]{40}$/.test(base??'') || /^0+$/.test(base)) return undefined;
 try {
  try {execFileSync('git',['cat-file','-e',`${base}^{commit}`],{cwd,stdio:'ignore'});}
  catch {execFileSync('git',['fetch','--no-tags','--depth=1','origin',base],{cwd,stdio:'pipe'});}
  return execFileSync('git',['diff','--name-only','-z',base,'HEAD'],{cwd,encoding:'utf8'}).split('\0').filter(Boolean);
 } catch {return undefined;} // An uncertain diff must run the complete checks.
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const files=changedFiles(process.env.CI_BASE_SHA);
 const runtime=files===undefined || needsRuntimeChecks(files);
 // Every push to main runs everything. Pull requests run what their files can affect.
 const everything=files===undefined || process.env.GITHUB_EVENT_NAME==='push';
 const bench=everything || needsBench(files), controls=everything || needsControls(files);
 if(process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,`runtime=${runtime}\nbench=${bench}\ncontrols=${controls}\n`);
 console.log(runtime?'Runtime checks required.':'Prose/assets only; runtime checks are unchanged.');
 if(runtime&&!bench) console.log('Nothing here can move the benchmark; its gate is skipped.');
 if(runtime&&!controls) console.log('Nothing here can change the walkthrough; it is skipped.');
}
