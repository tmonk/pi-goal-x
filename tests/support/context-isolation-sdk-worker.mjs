import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { captureOne } from "../../experiments/context/capture-context.mjs";

{
 const [disabled, active] = await Promise.all([captureOne("tasks-disabled"), captureOne("current-contracted-task")]);
 assert.ok(!disabled.tools.some(tool => tool.name === "update_goal_task"));
 assert.ok(active.tools.some(tool => tool.name === "update_goal_task"));
 assert.match(JSON.stringify(active.messages), /Finish the contracted migration/);
 assert.doesNotMatch(JSON.stringify(disabled.messages), /Finish the contracted migration/);
}

{
 let release;
 const barrier = new Promise(resolve => { release = resolve; });
 let arrived;
 const ready = new Promise(resolve => { arrived = resolve; });
 let siblingPath = "", failedPath = "";
 const sibling = captureOne("tasks-disabled", {inspect: async (_result, {cwd}) => {
  siblingPath = cwd;
  arrived();
  await barrier;
  assert.equal(JSON.parse(readFileSync(path.join(cwd, ".pi/pi-goal-x-settings.json"), "utf8")).disableTasks, true);
 }});
 await ready;
 try {
  await assert.rejects(captureOne("current-contracted-task", {inspect: (_result, {cwd}) => {
   failedPath = cwd;
   assert.notEqual(cwd, siblingPath);
   throw new Error("deliberate capture failure");
  }}), /deliberate capture failure/);
  assert.equal(existsSync(failedPath), false);
  assert.equal(existsSync(siblingPath), true);
 } finally { release(); }
 await sibling;
 assert.equal(existsSync(siblingPath), false);
}

console.log(JSON.stringify({passed: true, cases: 2}));
