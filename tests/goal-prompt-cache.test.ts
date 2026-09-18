import test from "node:test";
import assert from "node:assert/strict";
import { cacheGoalHistory } from "../extensions/goal-prompt-cache.ts";

const live = "[PI GOAL ACTIVE goalId=fixture]\nUsage: 123 tokens";
const control = {type: "ephemeral", ttl: "1h"};

test("explicit breakpoints move before transient state without changing TTL or tool ordering", () => {
 for (const content of ["history", [{type: "text", text: "history"}], [{type: "tool_result", tool_use_id: "id", content: "history"}]]) {
  const payload: any = {messages: [{role: "user", content}, {role: "user", content: [{type: "text", text: live, cache_control: control}]}]};
  assert.equal(cacheGoalHistory(payload, live), payload);
  assert.deepEqual(payload.messages[0].content.at(-1).cache_control, control);
  assert.equal(payload.messages[1].content[0].cache_control, undefined);
 }
 const sameMessage: any = {messages: [{role: "user", content: [{type: "text", text: "history"}, {type: "text", text: live, cache_control: control}]}]};
 cacheGoalHistory(sameMessage, live);
 assert.deepEqual(sameMessage.messages[0].content[0].cache_control, control);
 assert.equal(sameMessage.messages[0].content[1].cache_control, undefined);
 const thinking: any = {messages: [{role: "user", content: [{type: "text", text: "history"}]}, {role: "assistant", content: [{type: "thinking", thinking: "private"}]}, {role: "user", content: [{type: "text", text: live, cache_control: control}]}]};
 cacheGoalHistory(thinking, live);
 assert.deepEqual(thinking.messages[0].content[0].cache_control, control);
 assert.equal(thinking.messages[1].content[0].cache_control, undefined);
});

test("implicit caches, disabled caching, unknown payloads and another extension's tail are untouched", () => {
 for (const payload of [null, {input: []}, {messages: []}, {messages: [{role: "user", content: [{type: "text", text: live}]}]}, {messages: [{role: "user", content: [{type: "text", text: "another extension", cache_control: control}]}]}]) {
  const before = structuredClone(payload);
  assert.equal(cacheGoalHistory(payload, live), undefined);
  assert.deepEqual(payload, before);
 }
});

test("a contentless trailing message from the host does not defeat the repair", () => {
 // Pi's persistent-effort support appends an effort-only marker after the
 // message it has already marked for caching. Until that was tolerated the
 // breakpoint stayed on the live block, so only the prefix ahead of the
 // conversation was ever reusable.
 const marker = {role: "system", content: [], output_config: {effort: "high"}};
 for (const trailing of [marker, {role: "system", content: ""}, {role: "system", content: null}, {role: "system"}]) {
  const payload: any = {messages: [
   {role: "user", content: [{type: "text", text: "history"}]},
   {role: "user", content: [{type: "text", text: live, cache_control: control}]},
   structuredClone(trailing),
  ]};
  assert.equal(cacheGoalHistory(payload, live), payload);
  assert.deepEqual(payload.messages[0].content[0].cache_control, control);
  assert.equal(payload.messages[1].content[0].cache_control, undefined);
  assert.deepEqual(payload.messages[2], trailing);
 }

 const bedrock: any = {messages: [
  {role: "user", content: [{text: "history"}]},
  {role: "user", content: [{text: live}, {cachePoint: {type: "default", ttl: "1h"}}]},
  marker,
 ]};
 cacheGoalHistory(bedrock, live);
 assert.deepEqual(bedrock.messages[0].content.at(-1), {cachePoint: {type: "default", ttl: "1h"}});
 assert.deepEqual(bedrock.messages[1].content, [{text: live}]);

 // A trailing message that does carry content is still another extension's
 // business: the tail no longer matches the live block, so nothing moves.
 const foreign: any = {messages: [
  {role: "user", content: [{type: "text", text: "history"}]},
  {role: "user", content: [{type: "text", text: live, cache_control: control}]},
  {role: "user", content: [{type: "text", text: "another extension"}]},
 ]};
 const before = structuredClone(foreign);
 assert.equal(cacheGoalHistory(foreign, live), undefined);
 assert.deepEqual(foreign, before);
});

test("Bedrock moves its existing cachePoint before the live message", () => {
 const payload: any = {messages: [{role: "user", content: [{text: "history"}]}, {role: "user", content: [{text: live}, {cachePoint: {type: "default", ttl: "1h"}}]}]};
 cacheGoalHistory(payload, live);
 assert.deepEqual(payload.messages[0].content.at(-1), {cachePoint: {type: "default", ttl: "1h"}});
 assert.deepEqual(payload.messages[1].content, [{text: live}]);
});
