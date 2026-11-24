import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Shared JavaScript experiment entry point.
import { summarize, compareReports, investigateCache } from "../experiments/context/cache-compare.mjs";

const report = () => ({version: 1, rows: [{id: "fixture", ...summarize({messages: [{role: "system", content: "policy"}, {role: "user", content: "history"}], tools: [{name: "read", parameters: {type: "object"}}], prompt_cache_key: "fixed"})}]});

test("cache comparison rejects missing scenarios, early text, schemas, options, markers and duplicate blocks", () => {
	const baseline = report();
	assert.equal(compareReports(baseline, structuredClone(baseline)).scenarios, 1);
	const variants = [
	(r: any) => { r.rows = []; },
		(r: any) => { r.rows[0].blocks[0].hash = "edited"; },
		(r: any) => { r.rows[0].immutable = "reordered or changed tools"; },
		(r: any) => { r.rows[0].options = "rotating identity"; },
		(r: any) => { r.rows[0].markers = [{path: ["messages", "0"], value: {type: "ephemeral"}}]; },
		(r: any) => { r.rows[0].blocks.push(r.rows[0].blocks[1]); },
		];
	for (const mutate of variants) {
		const candidate = structuredClone(baseline);
		mutate(candidate);
		assert.throws(() => compareReports(baseline, candidate));
	}
	assert.throws(() => summarize({messages: [{role: "user", content: [{type: "text", text: "live", cache_control: {type: "ephemeral"}}]}]}, ["live"]), /marker on a transient/);
});

test("task progress from #108 no longer resets the prefix, and the gate rejects any reset", () => {
	const investigation = investigateCache();
	assert.equal(investigation.stateChanges.filter((step: any) => step.prefixBreak).length, 0);
	assert.equal(investigation.occupancy[1].appendedCounters, 0);
	assert.equal(investigation.occupancy[1].breaks, 0);
	assert.ok(investigation.occupancy[1].totalRequestBytes < investigation.occupancy[0].totalRequestBytes);
	const baseline = {...report(), investigation, corpus: {transitions: 1000, breaks: 32}};
	for (const mutate of [
	(r: any) => {r.investigation.stateChanges[0].kind = "unknown-reset";},
		(r: any) => {r.investigation.stateChanges[0].prefixBreak = true;},
		(r: any) => {r.investigation.occupancy[1].breaks = 1;},
		(r: any) => {r.investigation.occupancy[1].appendedCounters = 1;},
		(r: any) => {r.corpus.breaks++;},
		]) {
		const candidate = structuredClone(baseline); mutate(candidate);
		assert.throws(() => compareReports(baseline, candidate));
	}
});

test("goal text may be re-split but nothing else may change", () => {
	const make = (history: string, snapshot: string) => ({version: 1, rows: [{id: "split", ...summarize({messages: [{role: "user", content: history}, {role: "user", content: snapshot}]})}]});
	const baseline = make("history", "Goal snapshot: 12 tokens\nAutonomous runs: 1/3");
	assert.equal(compareReports(baseline, make("history", "Goal snapshot: 12 tokens")).approvedDifferences.length, 1);
	assert.throws(() => compareReports(baseline, make("edited history", "Goal snapshot: 12 tokens")), /non-goal content changed/);
});

test("cache gate rejects serialized early-content changes and removed or relocated markers", () => {
	const payload = {system: "host policy", messages: [{role: "user", content: [{type: "text", text: "stable history", cache_control: {type: "ephemeral"}}, {type: "text", text: "more history"}]}], tools: [{name: "read", parameters: {type: "object", properties: {}}}]};
	const wrap = (value: typeof payload) => ({version: 1, rows: [{id: "wire", ...summarize(value)}]});
	const baseline = wrap(payload);
	for (const mutate of [
	(p: any) => {p.system = "changed host policy";},
		(p: any) => {p.messages[0].content[0].text = "changed early history";},
		(p: any) => {p.tools[0].parameters.properties.path = {type: "string"};},
		(p: any) => {delete p.messages[0].content[0].cache_control;},
		(p: any) => {p.messages[0].content[1].cache_control = p.messages[0].content[0].cache_control; delete p.messages[0].content[0].cache_control;},
		]) {
		const candidate = structuredClone(payload); mutate(candidate);
		assert.throws(() => compareReports(baseline, wrap(candidate)));
	}
});
