/**
 * Drive a real SDK session through a goal's whole life (create, work, pause,
 * resume, a settings change, completion, a second goal) against a local fake
 * provider, and check that each request is a prefix of the next one. Only the
 * request-only last block may differ. A break here is a prompt-cache miss.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import goalExtension from '../../extensions/goal.ts';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-probe-'));
fs.mkdirSync(path.join(cwd, '.pi'));
fs.writeFileSync(path.join(cwd, 'sample.txt'), 'hello');
fs.writeFileSync(path.join(cwd, '.pi', 'pi-goal-x-settings.json'), JSON.stringify({ maxAutonomousRuns: 20, disabled: true }));
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(cwd, 'absent-global');
let core, session, piApi, compacting = false;
const requests = [];
const read = ['read', { path: 'sample.txt' }];
// The next requests answer with these tool calls, in order; after that the fake model just replies with text.
let compactedAt = -1;
const queue = [['create_goal', { objective: 'First goal.' }], read, read];
const server = http.createServer(async (req, res) => {
	let body = ''; for await (const chunk of req) body += chunk;
	requests.push({ ...JSON.parse(body), compaction: compacting });
	const call = queue.shift();
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}) })}\n\n`);
	if (call) {
		emit({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] });
		emit({}, 'tool_calls');
	} else { emit({ role: 'assistant', content: `Step ${requests.length} done.` }); emit({}, 'stop'); }
	res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const manager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider('fixture', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 512 }] });
async function openSession(sessionManager) {
	const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [pi => { goalExtension(pi); piApi = pi; core = pi._goalCore; }] });
	await loader.reload();
	({ session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, sessionManager, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 512 } }) }));
	await session.bindExtensions({});
}
await openSession(manager);
const steps = ['Please start a persistent goal.', '@wait', '@pause', '@wait', '@resume', '@pause', 'a question while paused', '@resume', '@pause', 'a question while paused', '@resume', '@pause', 'a question while paused', '@resume', '@pause', 'a question while paused', '@resume', '@pause', 'a question while paused', '@resume', '@pause', 'a question while paused', '@resume', '@pause', 'a question while paused', '@resume', '@pause', 'a question while paused', '@resume', '@settings:{"maxAutonomousRuns":9,"disabled":true}', '@wait', '@compact', '@wait', 'one more question after compaction', '@wait', '@complete', '@wait', 'Thanks, what was in the file?', '@wait', '@new:Second goal.', '@wait', 'work on second goal', '@new:Third goal, changed course.', '@wait', 'work on third goal'];
for (const step of steps) {
	if (step === '@pause') { core.lifecycle.pause(session.extensionRunner.createContext()); continue; }
	if (step === '@resume') { core.scheduler.resume(session.extensionRunner.createContext()); await delay(300); continue; }
	if (step.startsWith('@new:')) { core.lifecycle.create({ objective: step.slice(5), autoContinue: true, sisyphus: false }, session.extensionRunner.createContext()); await delay(1500); continue; }
	if (step.startsWith('@settings:')) { fs.writeFileSync(path.join(cwd, '.pi', 'pi-goal-x-settings.json'), step.slice(10)); await delay(300); continue; }
	if (step === '@complete') { queue.push(['update_goal', { status: 'complete', completion_summary: 'done' }]); await session.prompt('Finish the goal now.'); continue; }
	if (step === '@compact') {
		// Compaction rewrites history on purpose, so the request after it may start over.
		manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Keep the latest state.' }], timestamp: Date.now() });
		compacting = true;
		try { await session.compact('Summarize the fixture state.'); } finally { compacting = false; }
		compactedAt = requests.length;
		continue;
	}
	if (step === '@wait') { await delay(1500); continue; }
	if (step === '@wake') { const w = core.state.goal?.scheduler?.wait; piApi.events.emit('pi-goal:wake', { goalId: core.state.goal.id, waitToken: w?.token }); await delay(1500); continue; }
	await session.prompt(step);
}
await delay(1500);
await delay(1000);
// A new process: nothing retained in memory, the same session file reopened.
await session.dispose?.();
delete globalThis[Symbol.for('pi-goal-x.liveRetention')];
await openSession(SessionManager.open(manager.getSessionFile()));
await session.prompt('Back after a restart.');
await delay(1000);
const view = r => ({ tools: JSON.stringify(r.tools), system: JSON.stringify(r.messages.filter(m => m.role === 'system')), msgs: r.messages.filter(m => m.role !== 'system').map(m => JSON.stringify(m)) });
let prev, breaks = 0;
for (const [i, r] of requests.entries()) {
	if (r.compaction) continue;
	const v = view(r);
	if (prev && i !== compactedAt) {
		let shared = 0;
		while (shared < Math.min(prev.msgs.length, v.msgs.length) && prev.msgs[shared] === v.msgs[shared]) shared++;
		assert.equal(v.tools, prev.tools, `request ${i + 1}: the tool list changed`);
		assert.equal(v.system, prev.system, `request ${i + 1}: the system prompt changed`);
		// The last block of a request is request-only text and may differ.
		assert.ok(shared >= prev.msgs.length - 1, `request ${i + 1} stopped matching request ${i} at message ${shared} of ${prev.msgs.length}: ${prev.msgs[shared]?.slice(0, 120)}`);
		breaks += shared < prev.msgs.length - 1 ? 1 : 0;
	}
	prev = v;
}
const text = JSON.stringify(requests.at(-1).messages);
assert.ok(text.includes('PI GOAL ENDED'), 'the end of the first goal is stated');
assert.ok(text.includes('Second goal.'), 'the second goal reached the model');
if (!String(core.state.goal?.objective).includes("Third goal")) throw new Error("goal switch did not happen: " + core.state.goal?.objective);
console.log(JSON.stringify({ passed: true, requests: requests.length, breaks }));
await session.dispose?.();
server.close();
process.exit(0);
