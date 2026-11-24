import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {needsRuntimeChecks,needsBench,needsControls,changedFiles} from './ci-scope.mjs';
import {runChecks} from './ci-checks.mjs';

test('only known prose/assets skip runtime checks; uncertainty and mixed changes run them',()=>{
 assert.equal(needsRuntimeChecks(['README.md','docs/controls.md','specs/feature/TECH.md','assets/ranking.json']),false);
 for(const file of ['extensions/goal.ts','tests/goal-controls.test.ts','experiments/context/cache-report.mjs','experiments/context/capture-context.mjs','tests/goal-atomic-rename.test.ts','package-lock.json','.github/workflows/ci.yml','scripts/ci-scope.mjs','unknown.file']) {
  assert.equal(needsRuntimeChecks(['docs/controls.md',file]),true,file);
 }
 assert.equal(needsRuntimeChecks([]),true);
 assert.equal(changedFiles('0'.repeat(40)),undefined);
 assert.equal(changedFiles('not-a-sha'),undefined);
});

test('the benchmark gate is skipped only for tests and prose',()=>{
 assert.equal(needsBench(['tests/goal-controls.test.ts','docs/controls.md']),false);
 for(const file of ['extensions/goal.ts','experiments/bench/run-bench.mjs','tests/support/tui-test-utils.ts','tests/stubs/x.mjs','package-lock.json','.github/workflows/ci.yml','unknown.file']) assert.equal(needsBench(['tests/a.test.ts',file]),true,file);
 assert.equal(needsBench([]),true);
});

test('the walkthrough is skipped only when nothing it loads changed',()=>{
 assert.equal(needsControls(['tests/a.test.ts','experiments/bench/run-bench.mjs','scripts/ci-scope.mjs','docs/x.md']),false);
 for(const file of ['extensions/goal.ts','experiments/controls/cli-walkthrough.mjs','experiments/continuation/terminal.mjs','scripts/pi-host.mjs','package-lock.json','.github/workflows/ci.yml','unknown.file']) assert.equal(needsControls(['tests/a.test.ts',file]),true,file);
 assert.equal(needsBench(['experiments/controls/cli-walkthrough.mjs','scripts/test-ci.mjs']),false);
 assert.equal(needsBench(['scripts/pi-host.mjs']),true);
 assert.equal(needsControls([]),true);
});

test('change detection includes deleted runtime files and compares actual commit trees',()=>{
 const cwd=mkdtempSync(path.join(tmpdir(),'pi-ci-diff-'));
 const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
 try {
  git('init','--quiet'); git('config','user.name','CI test'); git('config','user.email','ci@example.invalid');
  writeFileSync(path.join(cwd,'README.md'),'Before\n');mkdirSync(path.join(cwd,'extensions'));writeFileSync(path.join(cwd,'extensions/goal.ts'),'export {};\n');
  git('add','.');git('commit','--quiet','-m','Initial');const base=git('rev-parse','HEAD');
  writeFileSync(path.join(cwd,'README.md'),'After\n');git('add','.');git('commit','--quiet','-m','Docs');
  assert.equal(needsRuntimeChecks(changedFiles(base,cwd)),false);
  rmSync(path.join(cwd,'extensions/goal.ts'));git('add','.');git('commit','--quiet','-m','Delete runtime');
  assert.equal(needsRuntimeChecks(changedFiles(base,cwd)),true);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('parallel checks collect all results, retain logs and propagate a failure',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'pi-ci-checks-'));
 try {
  const results=await runChecks([
   {name:'failed',args:['-e','console.error("expected failure");process.exit(7)']},
   {name:'passed',args:['-e','setTimeout(()=>console.log("finished"),100)']},
   {name:'later',args:['-e','console.log("also ran")']},
  ],{directory,quiet:true});
  assert.deepEqual(results.map(result=>result.passed),[false,true,true]);
  assert.equal(results[0].code,7);
  assert.match(readFileSync(results[0].log,'utf8'),/expected failure/);
  assert.match(readFileSync(results[1].log,'utf8'),/finished/);
  assert.equal(JSON.parse(readFileSync(path.join(directory,'results.json'),'utf8')).length,3);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('direct validation finds local executables without requiring a global CLI',async()=>{
 const cwd=mkdtempSync(path.join(tmpdir(),'pi-ci-path-'));
 try {
  const bin=path.join(cwd,'node_modules','.bin');mkdirSync(bin,{recursive:true});
  writeFileSync(path.join(bin,'pi-goal-ci-probe'),'#!/bin/sh\nprintf "local-tool-found\\n"\n',{mode:0o755});
  const results=await runChecks([{name:'local-cli',args:['-e','console.log(require("node:child_process").execFileSync("pi-goal-ci-probe",{encoding:"utf8"}))']}],{directory:path.join(cwd,'logs'),cwd,quiet:true});
  assert.equal(results[0].passed,true);
  assert.match(readFileSync(results[0].log,'utf8'),/local-tool-found/);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('full-suite checks reject skipped tests and missing summaries',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'pi-ci-skips-'));
 try {
  const results=await runChecks([
   {name:'skipped',args:['-e','console.log("ℹ skipped 2")'],noSkippedTests:true},
   {name:'missing',args:['-e','console.log("no summary")'],noSkippedTests:true},
   {name:'complete',args:['-e','console.log("ℹ skipped 0")'],noSkippedTests:true},
  ],{directory,quiet:true});
  assert.deepEqual(results.map(result=>result.passed),[false,false,true]);
  assert.match(results[0].error,/skipped 2/);
  assert.match(results[1].error,/skip count/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('every controls walkthrough case runs in exactly one CI group',()=>{
 const script=readFileSync(new URL('../experiments/controls/cli-walkthrough.mjs',import.meta.url),'utf8');
 const listed=script.split('\n').filter(line=>line.startsWith('const available=')||line.startsWith('available.push(')).join('\n');
 const cases=[...listed.matchAll(/\['([a-z-]+)',/g)].map(match=>match[1]);
 const workflow=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const grouped=[...workflow.matchAll(/^ {10}- ([a-z -]+)$/gm)].flatMap(match=>match[1].split(' '));
 assert.ok(cases.length>=10);
 assert.deepEqual([...grouped].sort(),[...cases].sort());
});
