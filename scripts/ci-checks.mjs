/** Independent suites use separate processes and fixtures; benchmarks run afterwards. */
import {spawn} from 'node:child_process';
import {createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';

export async function runChecks(checks, {directory, cwd=process.cwd(), concurrency=4, quiet=false}={}) {
 mkdirSync(directory,{recursive:true});
 // Match npm run: CLI checks must find the checkout's Pi, even without a global install.
 const env={...process.env,PATH:`${path.join(cwd,'node_modules','.bin')}${path.delimiter}${process.env.PATH??''}`};
 const results=new Array(checks.length);
 let next=0;
 await Promise.all(Array.from({length:Math.min(concurrency,checks.length)},async()=>{
  while(next<checks.length) {
   const index=next++, check=checks[index], started=Date.now();
   const log=path.join(directory,`${check.name}.log`);
   const stream=createWriteStream(log);
   let error;
   const child=spawn(process.execPath,check.args,{cwd,env,stdio:['ignore','pipe','pipe'],timeout:180000});
   child.stdout.pipe(stream,{end:false}); child.stderr.pipe(stream,{end:false});
   child.once('error',value=>{error=String(value);});
   const code=await new Promise(resolve=>child.once('close',resolve));
   await new Promise(resolve=>stream.end(resolve));
   const content=readFileSync(log,'utf8').trimEnd();
   if(check.noSkippedTests && code===0) {
    const summary=/^(?:ℹ|#)\s+skipped\s+(\d+)\s*$/m.exec(stripVTControlCharacters(content));
    if(!summary || Number(summary[1])!==0) error=summary?`Full suite skipped ${summary[1]} tests.`:'Full suite did not report its skip count.';
   }
   const result={name:check.name,passed:code===0&&!error,code,error,elapsedMs:Date.now()-started,log};
   results[index]=result;
   if(!quiet) {
    console.log(`${result.passed?'PASS':'FAIL'} ${check.name} (${(result.elapsedMs/1000).toFixed(1)}s)`);
    console.log(result.passed?content.split('\n').slice(-14).join('\n'):content);
    if(error) console.error(error);
   }
  }
 }));
 writeFileSync(path.join(directory,'results.json'),JSON.stringify(results,null,2)+'\n');
 return results;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const directory=process.env.PI_GOAL_CI_LOG_DIR??mkdtempSync(path.join(tmpdir(),'pi-goal-ci-'));
 process.env.PI_GOAL_PACKAGE_EVIDENCE??=path.join(directory,'package');
 process.env.PI_GOAL_CACHE_REPORT_DIR??=path.join(directory,'cache');
 console.log(`Validation logs: ${directory}`);
 const checks=[
  {name:'tests',args:['scripts/run-unit-tests.mjs','all','--selfcheck'],noSkippedTests:true},
  {name:'controls-cli',args:['experiments/controls/cli-walkthrough.mjs']},
  {name:'lifecycle-cli',args:['scripts/live-session-check.mjs']},
  {name:'package',args:['scripts/package-stabilization-check.mjs']},
  {name:'context',args:['experiments/context/run-gate.mjs']},
  {name:'provider',args:['--experimental-strip-types','experiments/context/provider-crosscheck.mjs']},
  {name:'cache',args:['--experimental-strip-types','experiments/context/cache-gate.mjs']},
  {name:'retention',args:['--experimental-strip-types','experiments/context/retention-check.mjs']},
 ];
 // `--skip name` leaves a check out and `--only name` keeps just that one, so CI can
 // run checks in jobs of their own. `--shard i/n` runs part of the test suite, and `--affected <sha>` only the test files
 // that the changes since that commit can reach.
 const option=name=>process.argv.slice(2).filter((arg,i,args)=>args[i-1]===name);
 const skip=option('--skip'), only=option('--only'), [shard]=option('--shard'), [affected]=option('--affected');
 const unknown=[...skip,...only].filter(name=>!checks.some(check=>check.name===name));
 if(unknown.length) throw new Error(`Unknown checks: ${unknown.join(', ')}`);
 const testArgs=checks.find(check=>check.name==='tests').args;
 if(shard) testArgs.push(`--shard=${shard}`);
 if(affected) testArgs.push(`--affected=${affected}`);
 const results=await runChecks(checks.filter(check=>!skip.includes(check.name)&&(!only.length||only.includes(check.name))),{directory});
 process.exitCode=results.every(result=>result.passed)?0:1;
}
