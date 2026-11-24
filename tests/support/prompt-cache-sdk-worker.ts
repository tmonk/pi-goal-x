import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { cacheGoalHistory } from "../../extensions/goal-prompt-cache.ts";
import { GOAL_AUDIT_ENTRY } from "../../extensions/goal-format.ts";
import { filterGoalSessionContext } from "../../extensions/goal-session-safety.ts";
import { LiveTailRetention } from "../../extensions/goal-live-retention.ts";
import {stabilizationHarness} from "./stabilization-utils.ts";
import { mutateSettingsLayer } from "../../extensions/settings/mutate.ts";

const live = "[PI GOAL ACTIVE goalId=fixture]\nUsage: 123 tokens";

test("real adapters preserve registered context visibility, retries and toggles", async () => {
	for (const flavor of ["openai-responses", "openai-completions", "anthropic-messages", "anthropic-compatible-completions"] as const) {
		const work = mkdtempSync(path.join(tmpdir(), "goal-visibility-wire-"));
		try {
			const runtime = await ModelRuntime.create({authPath: path.join(work, "auth"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false});
			const api = flavor === "anthropic-compatible-completions" ? "openai-completions" : flavor;
			runtime.registerProvider("visibility", {baseUrl: "http://127.0.0.1:1", api, apiKey: "fixture-only", models: [{id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 1000, maxTokens: 128}]});
			const model = runtime.getModel("visibility", "fixture")!;
			if (flavor === "anthropic-compatible-completions") model.compat = {cacheControlFormat: "anthropic", supportsLongCacheRetention: true};
			for (const cacheRetention of ["none", "short", "long"] as const) {
				const h = stabilizationHarness();
				try {
					h.ctx.model = model;
					await h.start();
					const base = [{role: "user", content: "real unchanged history", timestamp: 1}];
					const capture = async () => {
						const {messages} = await h.event("context_with_system", {messages: base});
						let payload: any;
						const tools = [...h.tools.values()].filter(tool => ["create_goal", "get_goal", "update_goal", "set_goal_tasks", "update_goal_task"].includes(tool.name));
						await runtime.streamSimple(model, {systemPrompt: "stable host", messages: convertToLlm(messages), tools}, {sessionId: "visibility-fixed", cacheRetention, onPayload: value => {
							payload = value; h.event("before_provider_request", {payload}); throw new Error("Captured before dispatch");
						}}).result();
						assert.ok(payload);
						return payload;
					};
					let previous = await capture();
					assert.doesNotMatch(JSON.stringify(previous), /Context snapshot:/);
					h.ctx.getContextUsage = () => ({tokens: 900, contextWindow: 1000});
					assert.deepEqual(await capture(), previous, "hidden occupancy does not change payloads");
					for (const value of [true, false, true]) {
						mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["showContextUsage"], value}});
						const next = await capture();
						assert.deepEqual(next.tools, previous.tools);
						assert.deepEqual(next.system, previous.system);
						if (flavor.startsWith("openai")) {
							const a = previous.input ?? previous.messages, b = next.input ?? next.messages;
							assert.deepEqual(b.slice(0, a.length), a, "toggle preserves the implicit prefix");
						}
						assert.deepEqual(await capture(), next, "retry adds no tail");
						const latest = h.core.state.goal!;
						assert.equal(latest.usage.tokensUsed, 0);
						previous = next;
					}
				} finally {await h.cleanup();}
			}
		} finally {rmSync(work, {recursive: true, force: true});}
	}
});
// Exercise Pi's actual serializers. onPayload throws before HTTP dispatch, so
// these checks require neither credentials nor a paid request.
for (const flavor of ["anthropic-messages", "openai-completions", "openai-responses", "anthropic-compatible-completions"] as const) {
	const api = flavor === "anthropic-compatible-completions" ? "openai-completions" : flavor;
	test(`real ${flavor} serialization preserves history and honors cache retention`, async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-cache-wire-"));
		try {
			const runtime = await ModelRuntime.create({authPath: path.join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false, ...{ refreshOnCreate: false }});
			runtime.registerProvider("cache-fixture", {baseUrl: "http://127.0.0.1:1", api, apiKey: "fixture-only", models: [{id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 128}]});
			const model = runtime.getModel("cache-fixture", "fixture")!;
			if (flavor === "anthropic-compatible-completions") model.compat = {cacheControlFormat: "anthropic", supportsLongCacheRetention: true};
			for (const cacheRetention of ["short", "long", "none"] as const) {
				const capture = async (text: string) => {
					let payload: any;
					const messages = convertToLlm([{role: "user", content: "unchanging history", timestamp: 1}, {role: "custom", customType: "pi-goal-live-context", content: text, display: false, timestamp: 0}]);
					await runtime.streamSimple(model, {systemPrompt: "unchanging policy", messages}, {cacheRetention, sessionId: "same-session", onPayload: value => {
						payload = value;
						cacheGoalHistory(payload, text);
						throw new Error("Intentional capture before network dispatch");
					}}).result();
					assert.ok(payload);
					return payload;
				};
				const first = await capture(live);
				const second = await capture(live.replace("123", "456"));
				const conversation = (p: any) => p.messages ?? p.input;
				assert.deepEqual(conversation(first).slice(0, -1), conversation(second).slice(0, -1), "serialized prefix is identical");
				assert.ok(JSON.stringify(conversation(second).at(-1)).includes("456 tokens"));
				if (api === "anthropic-messages" || flavor === "anthropic-compatible-completions") {
					const historyMessage = first.messages.find((m: any) => m.role === "user");
					const marker = Array.isArray(historyMessage.content) ? historyMessage.content.at(-1).cache_control : undefined;
					if (cacheRetention === "none") assert.equal(marker, undefined);
						else assert.equal(marker.type, "ephemeral");
					assert.ok(!JSON.stringify(first.messages.at(-1)).includes("cache_control"));
				}
			}
		} finally { rmSync(cwd, {recursive: true, force: true}); }
	});
}

// Advancing-history regression: a completed assistant turn entering history must
// not displace the previously sent goal-state tail. The production retention
// helper builds each request (hook wiring is tested separately): request
// N's serialized conversation must be an exact prefix of request N+1's, letting
// implicit caches (OpenAI Responses / Chat Completions, which carry no explicit
// marker) reuse the full prefix instead of freezing at the first injection point.
for (const flavor of ["openai-completions", "openai-responses"] as const) {
	test(`real ${flavor} serialization keeps an advancing prefix across assistant turns`, async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-cache-advance-"));
		try {
			const runtime = await ModelRuntime.create({authPath: path.join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false, ...{ refreshOnCreate: false }});
			runtime.registerProvider("advance-fixture", {baseUrl: "http://127.0.0.1:1", api: flavor, apiKey: "fixture-only", models: [{id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 128}]});
			const model = runtime.getModel("advance-fixture", "fixture")!;
			const retention = new LiveTailRetention();
			const capture = async (session: any[], fresh: { state: string; counters: string }) => {
				const { messages, transientContents } = retention.apply("advance-session", filterGoalSessionContext(session) ?? session, fresh);
				let payload: any;
				const wire = convertToLlm(messages);
				await runtime.streamSimple(model, {systemPrompt: "unchanging policy", messages: wire, tools: [{name: "read", description: "Read a file", parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"]}}]}, {cacheRetention: "short", sessionId: "same-session", onPayload: value => {
					payload = value;
					cacheGoalHistory(payload, transientContents);
					throw new Error("Intentional capture before network dispatch");
				}}).result();
				assert.ok(payload);
				return payload;
			};
			const session: any[] = [{role: "user", content: "unchanging history", timestamp: 1}];
			// A completed assistant turn carries usage and a terminal stopReason, exactly
			// as the SDK produces for real turns (the token estimator reads usage).
			const turn = (n: number, timestamp: number) => ({role: "assistant", content: [{type: "text", text: `completed result ${n}`}], stopReason: "stop", usage: {input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15}, timestamp});
			const state = "[PI GOAL ACTIVE goalId=fixture]\nObjective: hold the line";
			const first = await capture(session, {state, counters: "Usage: 100 tokens"});
			session.push(turn(1, 2));
			const second = await capture(session, {state, counters: "Usage: 200 tokens"});
			session.push(turn(2, 3));
			const third = await capture(session, {state, counters: "Usage: 300 tokens"});
			const conversation = (p: any) => p.messages ?? p.input;
			const a = conversation(first), b = conversation(second), c = conversation(third);
			assert.ok(a.length < b.length && b.length < c.length, "each advanced request carries its completed turn");
			assert.deepEqual(b.slice(0, a.length), a, "request N is an exact prefix of request N+1");
			assert.deepEqual(c.slice(0, b.length), b, "request N+1 is an exact prefix of request N+2");
			// Two advances add at most the completed turns plus their small counter tails:
			// the stable policy block is retained in place, never resent.
			assert.ok(c.length - a.length <= 4, "retained tails grow by state changes, not by requests");
			// Real tool-loop history, including parallel calls/results, followed by
			// a user turn. No retained user tail may split a call/result pair.
			session.push({...turn(3, 4), content: [
				{type: "toolCall", id: "call_a", name: "read", arguments: {path: "a"}},
				{type: "toolCall", id: "call_b", name: "read", arguments: {path: "b"}},
			], stopReason: "toolUse"});
			for (const id of ["call_a", "call_b"]) session.push({role: "toolResult", toolCallId: id, toolName: "read", content: [{type: "text", text: id}], isError: false, timestamp: 5});
			const fourth = conversation(await capture(session, {state, counters: "Usage: 400 tokens"}));
			assert.deepEqual(fourth.slice(0, c.length), c);
			assert.ok(!JSON.stringify(fourth).includes("No result provided"), "serializer never synthesizes an orphan result");
			assert.deepEqual(conversation(await capture(session, {state, counters: "Usage: 400 tokens"})), fourth, "retry does not grow the prompt");
			session.push(turn(4, 6), {role: "user", content: "continue", timestamp: 7});
			const fifth = conversation(await capture(session, {state, counters: "Usage: 500 tokens"}));
			assert.deepEqual(fifth.slice(0, fourth.length), fourth);
			// A result arriving after a captured call must remove the unsafe anchor.
			session.push({...turn(5, 8), content: [{type: "toolCall", id: "delayed", name: "read", arguments: {path: "missing"}}], stopReason: "toolUse"});
			await capture(session, {state, counters: "Usage: 600 tokens"});
			session.push({role: "custom", customType: GOAL_AUDIT_ENTRY, content: "DISPLAY ONLY AUDIT", display: true, timestamp: 9});
			session.push({role: "toolResult", toolCallId: "delayed", toolName: "read", content: [{type: "text", text: "file missing"}], isError: true, timestamp: 10});
			const delayed = await capture(session, {state, counters: "Usage: 700 tokens"});
			const delayedText = JSON.stringify(conversation(delayed));
			assert.equal(delayedText.split("Objective: hold the line").length - 1, 1, "exactly one current policy survives");
			assert.ok(!delayedText.includes("DISPLAY ONLY AUDIT"));
			assert.ok(!delayedText.includes("No result provided"));
			assert.ok(delayedText.includes("file missing"));
			const delayedWire = conversation(delayed);
			const callIndex = delayedWire.findIndex((m: any) => m.call_id === "delayed" && m.type === "function_call" || m.tool_calls?.some((c: any) => c.id === "delayed"));
			const resultIndex = delayedWire.findIndex((m: any) => m.call_id === "delayed" && m.type === "function_call_output" || m.tool_call_id === "delayed");
			assert.ok(callIndex >= 0);
			assert.equal(resultIndex, callIndex + 1, "wire result stays adjacent to the delayed call");
			// Policy edits and compaction reset retained state, while host/tools stay stable.
			const nextState = "[PI GOAL ACTIVE goalId=fixture]\nObjective: revised";
			const edited = await capture(session, {state: nextState, counters: "Usage: 800 tokens"});
			assert.ok(!JSON.stringify(conversation(edited)).includes("Objective: hold the line"));
			session.splice(0, session.length, {role: "user", content: "Compacted summary", timestamp: 11});
			for (let n = 0; n < 40; n++) {
				const fresh = {state: nextState, counters: `Goal snapshot: ${900 + n} tokens`};
				const payload = await capture(session, fresh);
				const text = JSON.stringify(conversation(payload));
				assert.ok(!text.includes("Usage: 800 tokens"));
				assert.equal(text.split("Objective: revised").length - 1, 1);
				assert.ok(text.split("Goal snapshot:").length - 1 <= 31);
				assert.deepEqual(payload.tools, first.tools, "tool schemas stay fixed through resets");
				assert.deepEqual(conversation(payload).filter((m: any) => m.role === "system" || m.role === "developer"), a.filter((m: any) => m.role === "system" || m.role === "developer"));
				assert.deepEqual(conversation(await capture(session, fresh)), conversation(payload), "retry at/after eviction is identical");
				session.push(turn(n + 6, n + 12));
			}
		} finally { rmSync(cwd, {recursive: true, force: true}); }
	});
}

for (const flavor of ["anthropic-messages", "anthropic-compatible-completions"] as const) {
	test(`real ${flavor} keeps explicit markers on history with retained split tails`, async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-cache-split-"));
		try {
			const runtime = await ModelRuntime.create({authPath: path.join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false, ...{ refreshOnCreate: false }});
			const api = flavor === "anthropic-messages" ? flavor : "openai-completions";
			runtime.registerProvider("split-fixture", {baseUrl: "http://127.0.0.1:1", api, apiKey: "fixture-only", models: [{id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 200000, maxTokens: 128}]});
			const model = runtime.getModel("split-fixture", "fixture")!;
			if (api === "openai-completions") model.compat = {cacheControlFormat: "anthropic", supportsLongCacheRetention: true};
			for (const cacheRetention of ["short", "long", "none"] as const) {
				const retention = new LiveTailRetention();
				const session: any[] = [{role: "user", content: "real history", timestamp: 1}];
				for (let n = 1; n <= 3; n++) {
					const {messages, transientContents} = retention.apply("split-session", session, {state: "policy", counters: `Usage: ${n}`});
					let payload: any;
					let before: any[] = [];
					const blocks = () => payload.messages.filter((m: any) => m.role !== "system" && m.role !== "developer").flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
					await runtime.streamSimple(model, {systemPrompt: "unchanging policy", messages: convertToLlm(messages)}, {cacheRetention, sessionId: "same-session", onPayload: value => {
						payload = value;
						before = blocks().filter((b: any) => b.cache_control).map((b: any) => structuredClone(b.cache_control));
						cacheGoalHistory(payload, transientContents);
						throw new Error("Intentional capture before network dispatch");
					}}).result();
					// SDK catches onPayload exceptions, so assertions must run outside it.
					assert.ok(payload);
					const marked = blocks().filter((b: any) => b.cache_control);
					assert.deepEqual(marked.map((b: any) => b.cache_control), before, "marker count and TTL are unchanged");
					assert.equal(marked.length, cacheRetention === "none" ? 0 : 1);
					assert.ok(marked.every((b: any) => !transientContents.includes(b.text)), "no live block owns the marker");
					if (marked.length) assert.equal(marked[0].text, `real history${n === 1 ? "" : ` ${n}`}`);
					session.push({role: "assistant", content: [{type: "text", text: `result ${n}`}], api, provider: model.provider, model: model.id, stopReason: "stop", usage: {input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15}, timestamp: n * 2});
					session.push({role: "user", content: `real history ${n + 1}`, timestamp: n * 2 + 1});
				}
			}
		} finally { rmSync(cwd, {recursive: true, force: true}); }
	});
}
