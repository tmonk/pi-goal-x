/** Probe: ignore. */
/** Keep required jobs present, while avoiding runtime checks for prose/assets only. */
import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export function needsRuntimeChecks(files) {
 return files.length === 0 || files.some(file => !/^(README\.md|CHANGELOG\.md|LICENSE|(?:docs|specs|assets)\/.*|pi-goal-x\.png)$/.test(file));
}

// The benchmark gate and the walkthrough in the Pi CLI are the slow checks. They run on every push
// to main, which covers releases, and not on pull requests. A diff we cannot read runs them too.
export function runsHeavyChecks(event, files) {
 return event!=='pull_request' || files===undefined;
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
 const heavy=runsHeavyChecks(process.env.GITHUB_EVENT_NAME,files), bench=heavy, controls=heavy;
 if(process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,`runtime=${runtime}\nbench=${bench}\ncontrols=${controls}\n`);
 console.log(runtime?'Runtime checks required.':'Prose/assets only; runtime checks are unchanged.');
 if(runtime&&!heavy) console.log('Pull request: the benchmark gate and the walkthrough run on main.');
}
