/**
 * Pick the test files a pull request can affect, from the files it changes.
 *
 * A test depends on every file it names: imports, worker scripts, fixtures. The links are followed
 * through those files in turn. A test that names a whole folder (like "extensions") depends on
 * everything in that folder. When unsure, say "all": the full suite always runs on main.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

const SOURCE=/\.(?:ts|mjs|js|json|md)$/;
// Whatever the tests do not load cannot change their result.
const IRRELEVANT=/^(?:(?:README|CHANGELOG)\.md|LICENSE|(?:docs|specs|assets)\/.*|pi-goal-x\.png)$/;
// A change here can alter how every test runs.
const EVERYTHING=/^(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|scripts\/(?:test-adapter-hooks|run-unit-tests)\.mjs|tests\/\.test-manifest\.json)$/;

const walk=(root,dir=root)=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
 const full=path.join(dir,entry.name);
 if(entry.name==='node_modules'||entry.name==='.git') return [];
 return entry.isDirectory()?walk(root,full):[path.relative(root,full).replaceAll('\\','/')];
});

export function testDependencies(root, tests) {
 const all=walk(root).filter(file=>!file.startsWith('experiments/runs/'));
 const known=new Set(all);
 const folders=new Set(all.map(file=>file.split('/')[0]).filter(name=>all.some(file=>file.startsWith(`${name}/`))));
 const cache=new Map();
 const direct=file=>{
  if(cache.has(file)) return cache.get(file);
  const found=new Set();
  cache.set(file,found);
  if(!SOURCE.test(file)) return found;
  const text=readFileSync(path.join(root,file),'utf8');
  for(const [,quoted] of text.matchAll(/["'`]([^"'`\n]{1,200})["'`]/g)) {
   if(folders.has(quoted)) { for(const other of all) if(other.startsWith(`${quoted}/`)) found.add(other); continue; }
   const candidates=[path.posix.join(path.posix.dirname(file),quoted),path.posix.normalize(quoted)];
   for(const candidate of candidates) if(known.has(candidate)) found.add(candidate);
   if(known.has(quoted)) found.add(quoted);
   const last=quoted.split('/').pop();
   // A path assembled from pieces, like join(dir, "support", "worker.mjs"), still names its last piece.
   if(last&&SOURCE.test(last)&&!quoted.includes('/')) for(const other of all) if(other.endsWith(`/${last}`)) found.add(other);
  }
  return found;
 };
 return new Map(tests.map(test=>{
  const seen=new Set([test]), queue=[test];
  while(queue.length) for(const next of direct(queue.pop())) if(!seen.has(next)) { seen.add(next); queue.push(next); }
  return [test,seen];
 }));
}

/** Returns the test files (repo-relative) to run, or 'all'. */
export function affectedTests(root, tests, changed) {
 if(changed===undefined) return 'all';
 const relevant=changed.filter(file=>!IRRELEVANT.test(file));
 // A deleted file cannot be followed from the tests that still name it, so run everything.
 if(relevant.some(file=>EVERYTHING.test(file)||!existsSync(path.join(root,file)))) return 'all';
 const deps=testDependencies(root,tests);
 return tests.filter(test=>relevant.some(file=>deps.get(test).has(file)));
}
