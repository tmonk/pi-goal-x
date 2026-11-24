/**
 * Provider regression fixture adapted from Longwu Ou's PR #97.
 * Exercises the installed SDK without the unit adapters or paid model calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import goalExtension from '../../extensions/goal.ts';
import { createGoal, goalFocusDetails } from '../../extensions/goal-record.ts';
import { writeActiveGoalFile } from '../../extensions/storage/goal-files.ts';

// An active goal edits every request. Pi must still receive a mid-session prompt change as a
// separate system message, so the leading prompt (the provider's cached prefix) stays byte-identical.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-context-sdk-'));
const cwd = path.join(work, 'project');
fs.mkdirSync(cwd);
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(work, 'absent-global.json');
const objective = 'Keep the cached prompt prefix stable.';
const calls = [];
const automatic = process.argv.includes('--automatic');
const child = process.argv.includes('--child');
if (child) process.env.PI_SUBAGENT_CHILD = '1';
fs.mkdirSync(path.join(cwd, '.pi'));
fs.writeFileSync(path.join(cwd, '.pi', 'pi-goal-x-settings.json'), JSON.stringify({maxAutonomousRuns:0}));
const server = http.createServer(async (req, res) => {
	let body = '';
	for await (const chunk of req) body += chunk;
	calls.push(JSON.parse(body));
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
	emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
	emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Done.' });
	emit({ type: 'response.output_item.done', output_index: 0, item });
	emit({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
	res.end();
});

let session;
try {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const manager = SessionManager.create(cwd, path.join(work, 'sessions'));
	const goal = createGoal({ objective, autoContinue: automatic, sisyphus: false });
	writeActiveGoalFile({ cwd }, goal);
	manager.appendCustomEntry('pi-goal-focus', goalFocusDetails(goal.id, 'created'));
	const runtime = await ModelRuntime.create({ authPath: path.join(work, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider('fixture', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-responses', apiKey: 'fixture-only', models: ['fixture','fixture-2'].map(id => ({ id, name: id, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 512, compat: { supportsMidConvoSystemMessages: true } })) });
	let turn = 0;
let initialTools;
	const loader = new DefaultResourceLoader({ cwd, agentDir: work, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [
		pi => goalExtension(pi, { runCompletionAuditor: async () => ({ approved: false, disapproved: false, output: '' }) }),
		pi => pi.on('before_agent_start', event => { { event.systemPromptOptions.sections.fixture_section = `fixture section version ${++turn}`; initialTools ??= [...event.systemPromptOptions.selectedTools]; event.systemPromptOptions.selectedTools = turn%2 ? initialTools : initialTools.filter(name => name !== 'bash'); } }),
	] });
	await loader.reload();
	({ session } = await createAgentSession({ cwd, agentDir: work, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), thinkingLevel: 'off', resourceLoader: loader, sessionManager: manager, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 512 } }) }));
	await session.bindExtensions({});
	for (const prompt of ['First request.', 'Second request.', 'Third request.']) await session.prompt(prompt);
	assert.equal(calls.length, 3);
	const text = value => JSON.stringify(value);
	for (const [i, payload] of calls.entries()) {
		assert.equal(text(payload.input.slice(1)).includes(objective), !child, `request ${i + 1} has the expected goal context`);
		assert.ok(text(payload.input).includes(`fixture section version ${i + 1}`), `request ${i + 1} carries its prompt section`);
	}

    {
        assert.deepEqual(calls[1].input[0], calls[0].input[0], 'the second request preserves the first prefix');
        assert.deepEqual(calls[2].input[0], calls[0].input[0], 'later prompt deltas preserve the first prefix');
        assert.ok(!text(calls[2].input[0]).includes('fixture section version 3'), 'the delta stays outside the prefix');
        assert.ok(calls[0].tools.some(tool => tool.name === 'bash'), 'the first tool profile includes bash');
        assert.ok(!calls[1].tools.some(tool => tool.name === 'bash'), 'the second tool profile removes bash');
        await session.setModel(runtime.getModel('fixture','fixture-2'));
        const changed = calls.length;
        await session.prompt('Continue on the new model.');
        await session.prompt('Continue on the same new model.');
        assert.deepEqual(calls[changed+1].input[0], calls[changed].input[0], 'model changes start a stable request prefix');
        await session.compact('Retain the current objective and progress.');
        const afterCompact = calls.length;
        await session.prompt('Continue after compaction.');
        await session.prompt('Continue once more.');
        assert.deepEqual(calls[afterCompact+1].input[0], calls[afterCompact].input[0], 'post-compaction requests preserve their prefix');
        assert.equal(text(calls.at(-1).input.slice(1)).includes(objective), !child, 'compaction retains the expected goal context');
    }
    console.log(JSON.stringify({passed:true, requests:calls.length, fullTranscript:true, automatic, child}));
} finally {
	if (session) { await session.abort(); session.dispose(); }
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
	fs.rmSync(work, { recursive: true, force: true });
}
