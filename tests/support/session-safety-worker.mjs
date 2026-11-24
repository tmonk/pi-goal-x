/** Real SDK regression worker; launched without the unit-test SDK adapters. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import goalExtension from '../../extensions/goal.ts';
import { createGoal, goalFocusDetails } from '../../extensions/goal-record.ts';
import { writeActiveGoalFile } from '../../extensions/storage/goal-files.ts';

const mode = process.argv[2];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-session-sdk-'));
const cwd = path.join(work, 'project');
fs.mkdirSync(cwd);
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(work, 'absent-global.json');
const calls = [];
let session;
let core;
let settled = false;
const transcript = [];
const child = mode.startsWith('child-');
const history = mode.startsWith('history-');
const staleReload = mode === 'stale-reload';
let reloaded = false;
const extensionErrors = [];
const api = mode === 'history-responses' ? 'openai-responses' : 'openai-completions';
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const server = http.createServer(async (req, res) => {
	let body = '';
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body);
	calls.push(payload);
	if (child) await delay(mode === 'child-fork' ? 6500 : 100);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	if (api === 'openai-responses') {
		const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Assignment finished.', annotations: [] }] };
		emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
		emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Assignment finished.' });
		emit({ type: 'response.output_item.done', output_index: 0, item });
		emit({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
		res.end();
		return;
	}
	const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
	if (!child && !history && calls.length === 1) {
		send({ role: 'assistant', tool_calls: [
			{ index: 0, id: 'call_info', type: 'function', function: { name: 'get_goal', arguments: '{}' } },
			{ index: 1, id: 'call_complete', type: 'function', function: { name: 'update_goal', arguments: '{"status":"complete"}' } },
		] });
		send({}, 'tool_calls');
	} else {
		send({ role: 'assistant', content: 'Assignment finished.' });
		send({}, 'stop');
	}
	res.end('data: [DONE]\n\n');
});

function snapshot(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { recursive: true }).sort().filter(name => fs.statSync(path.join(dir, name)).isFile()).map(name => [name, fs.readFileSync(path.join(dir, name)).toString('base64')]);
}

function assertPaired(payload) {
	if (payload.messages) {
		let pending = new Set();
		for (const message of payload.messages) {
			if (message.role === 'tool') {
				assert.ok(pending.delete(message.tool_call_id), `unpaired/duplicate tool result ${message.tool_call_id}`);
				assert.notEqual(message.content, 'No result provided');
			} else {
				assert.equal(pending.size, 0, 'non-tool message interrupts pending results');
				pending = new Set(message.tool_calls?.map(call => call.id) ?? []);
			}
		}
		assert.equal(pending.size, 0);
	} else {
		const ids = payload.input.filter(item => item.type === 'function_call').map(item => item.call_id);
		const outputs = payload.input.filter(item => item.type === 'function_call_output');
		assert.equal(outputs.length, ids.length);
		assert.equal(new Set(outputs.map(item => item.call_id)).size, outputs.length);
		assert.ok(outputs.every(item => ids.includes(item.call_id) && item.output !== 'No result provided'));
	}
	assert.ok(!JSON.stringify(payload).includes('AUDIT DISPLAY ONLY'));
}

try {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	let manager = SessionManager.create(cwd, path.join(work, 'sessions'));
	let goal;
	if (!history) {
		goal = createGoal({ objective: 'Finish the delegated assignment with tested evidence.', autoContinue: child, sisyphus: false });
		if (mode === 'skip') goal.skipAuditor = true;
		writeActiveGoalFile({ cwd }, goal);
		if (mode !== 'child-fresh') manager.appendCustomEntry('pi-goal-focus', goalFocusDetails(goal.id, 'created'));
	}
	if (history || (child && mode !== 'child-fresh')) {
		manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Inherited assignment context' }], timestamp: 1 });
		manager.appendMessage({ role: 'assistant', provider: 'fixture', api, model: 'fixture', content: [
			{ type: 'toolCall', id: 'call_info', name: 'get_goal', arguments: {} },
			{ type: 'toolCall', id: 'call_complete', name: 'update_goal', arguments: { status: 'complete' } },
		], usage, stopReason: 'toolUse', timestamp: 2 });
		manager.appendCustomMessageEntry('pi-goal-audit-event', 'AUDIT DISPLAY ONLY', true, { phase: 'started' });
		for (const [id, name] of [['call_info', 'get_goal'], ['call_complete', 'update_goal']]) manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: `actual result ${id}` }], isError: false, timestamp: 3 });
		manager.appendCustomMessageEntry('other-extension', 'UNRELATED DISPLAY PRESERVED', true, {});
		if (child) manager.appendCustomMessageEntry('pi-goal-event', `<pi_goal_continuation goal_id="${goal.id}" kind="checkpoint" v="2"/>`, false, { version: 2, kind: 'checkpoint', goalId: goal.id });
		if (mode === 'child-fork' || mode === 'child-nested') {
			const fork = manager.createBranchedSession(manager.getLeafId());
			assert.ok(fork);
			manager = SessionManager.open(fork);
		} else if (mode === 'child-resume') manager = SessionManager.open(manager.getSessionFile());
	}
	const beforeFiles = snapshot(path.join(cwd, '.pi'));
	const beforeEntries = manager.getEntries().filter(e => e.type === 'custom' && e.customType?.startsWith('pi-goal'));
	const runtime = await ModelRuntime.create({ authPath: path.join(work, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider('fixture', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api, apiKey: 'fixture-only', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 512 }] });
	const loader = new DefaultResourceLoader({ cwd, agentDir: work, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [pi => {
		// Reload from an earlier handler after Pi has captured the settlement
		// context. The remaining old handlers receive a genuinely stale ctx.
		if (staleReload) pi.on('agent_settled', async () => {
			if (reloaded) return;
			reloaded = true;
			await session.reload();
		});
		goalExtension(pi, { runCompletionAuditor: async () => {
			assert.equal(transcript.length, 0, 'audit messages must wait for the completion tool result');
			return { approved: mode === 'approve', disapproved: mode === 'reject', output: mode === 'approve' ? 'Evidence verified\n<approved/>' : 'More evidence needed\n<disapproved/>', ...(mode === 'abort' ? { error: 'Auditor aborted.' } : mode === 'error' ? { error: 'Fixture auditor error' } : {}) };
		} });
		core = pi._goalCore;
		pi.on('agent_settled', () => { settled = true; });
	}] });
	await loader.reload();
	({ session } = await createAgentSession({ cwd, agentDir: work, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), thinkingLevel: 'off', resourceLoader: loader, sessionManager: manager, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }) }));
	session.subscribe(event => {
		if (event.type === 'message_end' && event.message.role === 'custom' && event.message.customType === 'pi-goal-audit-event') {
			assert.equal(session.isIdle, true, 'audit transcript is emitted only while idle');
			transcript.push(event.message);
		}
	});
	await session.bindExtensions({});
	const originalRunner = session.extensionRunner;
	originalRunner.onError(error => extensionErrors.push(error));
	await session.prompt(child ? 'Complete only this delegated assignment.' : 'Complete the goal.');
	assert.ok(settled);
	if (staleReload) {
		assert.equal(reloaded, true);
		assert.notEqual(session.extensionRunner, originalRunner);
		assert.throws(() => originalRunner.createContext().sessionManager, /This extension ctx is stale/);
		assert.deepEqual(extensionErrors, [], 'stale audit settlement must not become an extension error');
		assert.equal(core.state.goal, null, 'completed goal stays archived after reload');
		assert.equal(transcript.length, 0, 'old audit messages cannot enter the replacement session');
		const before = calls.length;
		await session.prompt('Report the resulting state after reload.');
		assert.equal(calls.length, before + 1, 'replacement context remains usable');
	} else if (child) {
		assert.equal(core, undefined);
		assert.equal(calls.length, 1, 'one assignment must produce exactly one request');
		assert.ok(!session.getActiveToolNames().some(name => ['create_goal', 'get_goal', 'update_goal', 'set_goal_tasks', 'update_goal_task'].includes(name)));
		assert.ok(!JSON.stringify(calls).includes('pi_goal_continuation'));
		assert.ok(!JSON.stringify(calls).includes('PI GOAL UNFOCUSED'));
		assert.equal(session.messages.at(-1).content[0].text, 'Assignment finished.');
		assert.deepEqual(snapshot(path.join(cwd, '.pi')), beforeFiles, 'parent goal files/ledger/settings must be byte-identical');
		assert.deepEqual(manager.getEntries().filter(e => e.type === 'custom' && e.customType?.startsWith('pi-goal')), beforeEntries, 'child must not append focus/state entries');
	} else if (history) {
		assert.equal(calls.length, 1);
		assert.ok(JSON.stringify(calls[0]).includes('UNRELATED DISPLAY PRESERVED'));
		assert.equal(session.messages.at(-1).content[0].text, 'Assignment finished.');
	} else {
		const before = calls.length;
		await delay(100);
		assert.equal(calls.length, before, 'audit transcript must not trigger an extra model request');
		const entries = manager.getBranch();
		const resultIndex = entries.findIndex(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'call_complete');
		const auditIndex = entries.findIndex(e => e.type === 'custom_message' && e.customType === 'pi-goal-audit-event');
		assert.ok(resultIndex >= 0 && auditIndex > resultIndex, 'audit display entries follow the actual completion result');
		const phases = transcript.map(m => m.details.phase);
		assert.deepEqual(phases, mode === 'skip' ? ['skipped'] : mode === 'abort' ? ['started'] : ['started', mode === 'approve' ? 'approved' : 'rejected']);
		await session.prompt('Report the resulting state.');
		assert.equal(calls.length, before + 1);
	}
	for (const payload of calls) assertPaired(payload);
	console.log(JSON.stringify({ mode, passed: true, requests: calls.length, auditMessages: transcript.length }));
} finally {
	if (session) { await session.abort(); session.dispose(); }
	core?.stopAuditAnimation();
	core?.clearAuditResult();
	core?.clearContinuationState();
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
	fs.rmSync(work, { recursive: true, force: true });
}
