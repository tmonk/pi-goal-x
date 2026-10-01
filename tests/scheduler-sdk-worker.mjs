/** Exercise actual SDK custom-message run boundaries, not the adapter mocks. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import goalExtension from '../extensions/goal.ts';
import { createGoal, goalFocusDetails } from '../extensions/goal-record.ts';
import { writeActiveGoalFile } from '../extensions/storage/goal-files.ts';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-sdk-'));
fs.mkdirSync(path.join(cwd, '.pi'));
const implicit = process.argv.includes('--implicit');
const uncapped = process.argv.includes('--uncapped');
fs.writeFileSync(path.join(cwd, '.pi', 'pi-goal-x-settings.json'), JSON.stringify({ ...(!implicit ? { strictExecutionContract: true } : {}), ...(!uncapped ? { maxAutonomousRuns: 4 } : {}) }));
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(cwd, 'absent-global');
let session, core, piApi;
const requests = [];
const lifecycleMode = process.argv.includes("--lifecycle");
let failedRequests = 0, compactionRequests = 0, workRequests = 0, compacting = false, retries = 0;
const server = http.createServer(async (req, res) => {
	let body = ''; for await (const chunk of req) body += chunk;
	requests.push(JSON.parse(body));
	if (lifecycleMode && failedRequests < 1) {
		failedRequests++;
		res.writeHead(503, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable', type: 'server_error' } }));
		return;
	}
	const n = compacting ? (compactionRequests++, -1) : ++workRequests;
	let call;
	if (n === 1) call = ['write', { path: 'sample.txt', content: 'fixture' }];
	if (n === 2 || n === 6) call = ['update_goal', { continuation: { kind: 'ready' } }];
	if (n === 3 || n === 5) call = ['read', { path: 'sample.txt' }];
	if (n === 4) call = ['update_goal', { continuation: { kind: 'wait', reason: 'Await producer', deadline: new Date(Date.now() + 15000).toISOString(), polling: { interval_seconds: 10, max_checks: 1 } } }];
	if (implicit) call = undefined;
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
	if (call) {
		emit({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] });
		emit({}, 'tool_calls');
	} else { emit({ role: 'assistant', content: 'No disposition supplied.' }); emit({}, 'stop'); }
	res.end('data: [DONE]\n\n');
});
async function until(predicate) {
	const deadline = Date.now() + 10000;
	while (!predicate() && Date.now() < deadline) await delay(20);
	assert.ok(predicate(), `state timeout: ${JSON.stringify(core?.state.goal?.scheduler)} requests=${requests.length}`);
}
try {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const manager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
	const goal = createGoal({ objective: 'Exercise explicit scheduling.', autoContinue: true, sisyphus: false });
	writeActiveGoalFile({ cwd }, goal); manager.appendCustomEntry('pi-goal-focus', goalFocusDetails(goal.id, 'created'));
	const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider('fixture', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 512 }] });
	const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [pi => { goalExtension(pi); piApi = pi; core = pi._goalCore; }] });
	await loader.reload();
	({ session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, sessionManager: manager, settingsManager: SettingsManager.inMemory({ retry: { enabled: lifecycleMode, maxRetries: 3, baseDelayMs: 10 }, compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 512 } }) }));
	await session.bindExtensions({});
	session.subscribe(event => { if (event.type === 'auto_retry_start') retries++; });
	await session.prompt('Run the fixture.');
	if (implicit) {
		await until(() => core.state.goal?.status === 'paused' && session.isIdle);
		assert.equal(workRequests, 5, 'host execution plus four declaration-free continuations');
		assert.equal(core.state.goal.scheduler.used, 4);
		assert.match(core.state.goal.pauseReason, /allowance exhausted/);
		assert.ok(!JSON.stringify(requests).includes('This is the only repair prompt'));
	} else {
	await until(() => core.state.goal?.scheduler?.phase === 'waiting' && session.isIdle);
	assert.equal(workRequests, 4);
	assert.equal(core.state.goal.scheduler.used, 1);
	await delay(200); assert.equal(workRequests, 4, 'waiting must not spin after reads or writes');
	if (lifecycleMode) {
		// Add a persisted turn boundary so this short scripted session is compactable.
		manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Retain the latest waiting state.' }], timestamp: Date.now() });
		compacting = true;
		try { await session.compact('Summarize the fixture state.'); } finally { compacting = false; }
		assert.equal(compactionRequests, 1);
		assert.equal(core.state.goal.scheduler.used, 1, 'host compaction does not spend an extension run');
		assert.equal(core.state.goal.scheduler.phase, 'waiting');
	}
	const waitToken = core.state.goal.scheduler.wait.token;
	piApi.events.emit('pi-goal:wake', { goalId: goal.id, waitToken });
	piApi.events.emit('pi-goal:wake', { goalId: goal.id, waitToken });
	await until(() => core.state.goal?.status === 'paused' && session.isIdle);
	assert.equal(workRequests, 8, 'ready, wake, ready, one repair only');
	assert.equal(core.state.goal.scheduler.used, 4);
	if (uncapped) assert.match(core.state.goal.pauseReason, /No execution disposition/, 'uncapped mode stops after its only repair');
	// Next actions were removed, so a repair dispatch carries no per-run text. The
	// mechanism is unchanged: the repair is spent and the goal then pauses.
	assert.equal(core.state.goal.scheduler.repairUsed, true, 'the repair dispatch was spent');
	assert.ok(!JSON.stringify(requests).includes('This is the only repair prompt'), 'no next-action repair text reaches the provider');
	await delay(200); assert.equal(workRequests, 8);
	const liveContext = JSON.stringify(requests[lifecycleMode ? 3 : 2]);
	assert.ok(liveContext.includes('PI GOAL ACTIVE'), 'custom-message run receives the goal prompt with current scheduling context');
	assert.ok(!liveContext.includes('Inspect the fixture result'), 'a declared next action is never stored or echoed');
	const oldCheckpoint = session.messages.find(m => m.role === 'custom' && m.customType === 'pi-goal-event');
	assert.ok(oldCheckpoint);
	piApi.sendMessage({ customType: 'pi-goal-event', content: oldCheckpoint.content, details: oldCheckpoint.details, display: false }, { triggerTurn: true, deliverAs: 'followUp' });
	await delay(200);
	assert.equal(workRequests, 8, 'stale dispatch is rejected before another provider request');
	if (lifecycleMode) {
		assert.equal(failedRequests, 1);
		assert.ok(retries > 0, 'actual Pi retry lifecycle was exercised');
		assert.equal(requests.length, 10, 'eight work requests, one failed attempt, one compaction');
	}
	}
	const requestChars = requests.map(r => JSON.stringify(r).length);
	const liveContextChars = requests.map(r => (r.messages ?? []).filter(m => JSON.stringify(m.content).includes('[CURRENT EXECUTION STATE')).reduce((n, m) => n + JSON.stringify(m.content).length, 0));
	console.log(JSON.stringify({ passed: true, requests: requests.length, used: core.state.goal.scheduler.used, retries, compactionRequests, requestChars, liveContextChars }));
} finally {
	core?.scheduler.shutdown(); core?.runtime.clearContinuationState();
	if (session) { await session.abort(); session.dispose(); }
	server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
	fs.rmSync(cwd, { recursive: true, force: true });
}
