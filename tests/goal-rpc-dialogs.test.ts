import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runGoalQuestionnaire, showProposalDialog, type GoalQuestionnaireResult } from "../extensions/goal-questionnaire.ts";

function host(picks: (number | undefined)[] = [], inputs: (string | undefined)[] = []) {
	const dialogs: { title: string; options?: string[] }[] = [];
	const ctx = {
		hasUI: true, mode: "rpc", cwd: "/test",
		ui: {
			// Default stub: a host that advertises `custom` but yields no result (its
			// TUI cannot render the component), so the questionnaire degrades to
			// per-question dialogs. Tests needing a capable/throwing host override it.
			custom: (async () => undefined) as unknown as ExtensionContext["ui"]["custom"],
			setWorkingVisible: () => {},
			notify: () => {},
			select: async (title: string, options: string[]) => {
				dialogs.push({ title, options });
				const index = picks.shift();
				return index === undefined ? undefined : options[index];
			},
			input: async (title: string) => { dialogs.push({ title }); return inputs.shift(); },
		},
	} as unknown as ExtensionContext;
	return { ctx, dialogs };
}

const question = { id: "scope", question: "Scope?", context: "All the details", options: ["A", "B"], recommended: 1 };

test("rpc hosts that DO render TUI components get the rich dialog (no per-question dialogs)", async () => {
	const h = host([9]); // would pick option 9 in a per-question dialog — must never be reached
	let sawRichRender = false;
	h.ctx.ui.custom = (async (factory: unknown) => {
		const tui = {
			getShowHardwareCursor: () => true,
			setShowHardwareCursor: () => {},
			requestRender: () => {},
			terminal: { rows: 40, columns: 92 },
		};
		const theme = { fg: (_color: string, text: string) => text };
		const component = (factory as (t: unknown, th: unknown, kb: unknown, done: unknown) => { render: (w: number) => string[] })(tui, theme, {}, () => {});
		const lines = component.render(92);
		sawRichRender = Array.isArray(lines) && lines.length > 0;
		return {
			questions: [{ id: question.id, question: question.question, options: question.options }],
			answers: [{ id: question.id, question: question.question, answer: "B", wasCustom: false }],
			cancelled: false,
			auditorEnabled: true,
		};
	}) as typeof h.ctx.ui.custom;
	const result = await runGoalQuestionnaire(h.ctx, [question]);
	assert.equal(sawRichRender, true, "the rich dialog component must render lines");
	assert.equal(h.dialogs.length, 0, "no per-question dialog may be used when the rich dialog renders");
	assert.equal(result.answers[0]?.answer, "B");
});

test("an rpc host that advertises custom but throws degrades instead of failing the draft", async () => {
	const h = host([1]);
	h.ctx.ui.custom = (async () => { throw new Error("host cannot render TUI dialogs"); }) as typeof h.ctx.ui.custom;
	const result = await runGoalQuestionnaire(h.ctx, [question]);
	assert.equal(result.answers[0]?.answer, "B", "rpc hosts keep their safety net: throw -> per-question dialogs");
	assert.equal(h.dialogs.length, 1);
});

type RichComponent = {
	render: (width: number) => string[];
	handleInput?: (data: string) => void;
	invalidate?: () => void;
	focused?: boolean;
};

/** Mount the rich questionnaire with a capable fake TUI and hand back the component. */
function mountRichDialog(h: ReturnType<typeof host>, tui: unknown = {
	getShowHardwareCursor: () => true,
	setShowHardwareCursor: () => {},
	requestRender: () => {},
	terminal: { rows: 40, columns: 92 },
}) {
	let resolveDone: (value: unknown) => void = () => {};
	const done = new Promise<unknown>((resolve) => { resolveDone = resolve; });
	let component: RichComponent | undefined;
	h.ctx.ui.custom = (async (factory: unknown) => {
		const theme = { fg: (_color: string, text: string) => text };
		component = (factory as (t: unknown, th: unknown, kb: unknown, cb: (v: unknown) => void) => RichComponent)(tui, theme, {}, (value) => resolveDone(value));
		return await done;
	}) as typeof h.ctx.ui.custom;
	return { done, getComponent: () => component };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the rich dialog commits the recommended answer on Enter (forwarded keystrokes)", async () => {
	const h = host([9]);
	const { done, getComponent } = mountRichDialog(h);
	const pending = runGoalQuestionnaire(h.ctx, [question]);
	const component = getComponent();
	assert.ok(component, "component must be created synchronously by the factory");
	component!.focused = true;
	for (let i = 0; i < 4; i++) {
		const settled = await Promise.race([done.then(() => true), flush().then(() => false)]);
		if (settled) break;
		component!.handleInput?.("\r");
		await flush();
	}
	const result = await pending as GoalQuestionnaireResult;
	assert.equal(result.cancelled, false);
	assert.equal(result.answers[0]?.answer, "B", "Enter confirms the recommended option");
	assert.equal(h.dialogs.length, 0, "no per-question dialog may be used");
});

test("Escape on the rich dialog cancels with a defined result (never falls back)", async () => {
	const h = host([9]);
	const { done, getComponent } = mountRichDialog(h);
	const pending = runGoalQuestionnaire(h.ctx, [question]);
	const component = getComponent();
	component!.focused = true;
	component!.handleInput?.("\x1b");
	const resolved = await Promise.race([done.then((v) => v), flush().then(() => undefined)]);
	assert.ok(resolved !== undefined, "Escape must produce a defined result, not the factory bail-out");
	const result = await pending as GoalQuestionnaireResult;
	assert.equal(result.cancelled, true);
	assert.equal(h.dialogs.length, 0, "cancelling must not resurrect per-question dialogs");
});

test("a synchronously throwing custom is treated like a rejection (rpc degrades, non-rpc surfaces)", async () => {
	const rpcHost = host([1]);
	rpcHost.ctx.ui.custom = (() => { throw new Error("host cannot render TUI dialogs"); }) as unknown as typeof rpcHost.ctx.ui.custom;
	assert.equal((await runGoalQuestionnaire(rpcHost.ctx, [question])).answers[0]?.answer, "B");

	const synHost = host([1]);
	delete (synHost.ctx as Partial<ExtensionContext>).mode;
	synHost.ctx.ui.custom = (() => { throw new Error("Host disconnected"); }) as unknown as typeof synHost.ctx.ui.custom;
	await assert.rejects(() => runGoalQuestionnaire(synHost.ctx, [question]), /Host disconnected/);
});

test("the proposal confirmation shares the rpc safety net", async () => {
	const h = host([0, 0]);
	h.ctx.ui.custom = (async () => { throw new Error("host cannot render TUI dialogs"); }) as typeof h.ctx.ui.custom;
	const result = await showProposalDialog(h.ctx, "OBJECTIVE", "goal", true);
	assert.equal(result.decision, "confirm", "proposal confirm falls back to the per-question dialogs");
	assert.equal(h.dialogs.length, 2, "auditor toggle + confirmation");
});

test("a non-rpc host that throws keeps upstream semantics (the error surfaces)", async () => {
	const h = host([1]);
	delete (h.ctx as Partial<ExtensionContext>).mode;
	h.ctx.ui.custom = (async () => { throw new Error("Host disconnected"); }) as typeof h.ctx.ui.custom;
	await assert.rejects(() => runGoalQuestionnaire(h.ctx, [question]), /Host disconnected/);
	assert.equal(h.dialogs.length, 0);
});

test("a TUI-less host still bails out through the factory capability check", async () => {
	const h = host([1]);
	h.ctx.ui.custom = (async (factory: unknown) => {
		const component = (factory as (t: unknown, th: unknown, kb: unknown, done: unknown) => { render: (w: number) => string[] })(() => {}, {}, {}, () => {});
		assert.deepEqual(component.render(80), []);
		return undefined;
	}) as unknown as ExtensionContext["ui"]["custom"];
	const result = await runGoalQuestionnaire(h.ctx, [question]);
	assert.equal(result.answers[0]?.answer, "B");
	assert.equal(h.dialogs.length, 1);
});

test("per-question dialogs still preserve recommendation labels when custom is absent", async () => {
	const h = host([1]);
	delete (h.ctx.ui as Partial<ExtensionContext["ui"]>).custom;
	const result = await runGoalQuestionnaire(h.ctx, [question]);
	assert.equal(result.answers[0]?.answer, "B");
	assert.deepEqual(h.dialogs[0], { title: "Scope?\n\nAll the details", options: ["1. A", "2. B (Recommended)", "3. Write your own answer..."] });
});

test("unknown-mode web factory arguments fall back without throwing", async () => {
	const h = host([0]);
	delete (h.ctx as Partial<ExtensionContext>).mode;
	h.ctx.ui.custom = (async (factory: any) => new Promise(resolve => {
		const component = factory(() => {}, {}, {}, resolve);
		assert.deepEqual(component.render(80), []);
	})) as typeof h.ctx.ui.custom;
	assert.equal((await runGoalQuestionnaire(h.ctx, [question])).answers[0]?.answer, "A");
});

test("missing custom falls back and only requires primitives the questions use", async () => {
	const h = host([0]);
	delete (h.ctx as Partial<ExtensionContext>).mode;
	delete (h.ctx.ui as Partial<ExtensionContext["ui"]>).custom;
	delete (h.ctx.ui as Partial<ExtensionContext["ui"]>).input;
	assert.equal((await runGoalQuestionnaire(h.ctx, [{ ...question, allowCustom: false }])).cancelled, false);
	assert.equal((await runGoalQuestionnaire(h.ctx, [question])).unavailable, true);
});

test("free text is direct, trims answers, and reprompts whitespace", async () => {
	const h = host([], ["  ", "  my answer  "]);
	delete (h.ctx.ui as Partial<ExtensionContext["ui"]>).select;
	const result = await runGoalQuestionnaire(h.ctx, [{ ...question, options: [] }]);
	assert.equal(result.answers[0]?.answer, "my answer");
	assert.equal(result.answers[0]?.wasCustom, true);
	assert.equal(h.dialogs.length, 2);
	assert.ok(h.dialogs.every(d => !d.options && d.title.includes(question.context)));
});

test("duplicate and reserved labels cannot become a custom answer accidentally", async () => {
	const q = { ...question, options: ["Write your own answer...", "Same", "Same"] };
	const selected = await runGoalQuestionnaire(host([0]).ctx, [q]);
	assert.equal(selected.answers[0]?.wasCustom, false);
	assert.equal(selected.answers[0]?.answer, q.options[0]);
	const custom = host([3], ["new answer"]);
	assert.equal((await runGoalQuestionnaire(custom.ctx, [q])).answers[0]?.wasCustom, true);
	assert.match(custom.dialogs[1]!.title, /All the details/);
});

test("cancellation on a later question or custom input discards every answer", async () => {
	for (const h of [host([0, undefined]), host([0, 2], [undefined])]) {
		const result = await runGoalQuestionnaire(h.ctx, [question, { ...question, id: "second" }]);
		assert.equal(result.cancelled, true);
		assert.deepEqual(result.answers, []);
	}
});

for (const enabled of [true, false]) {
	for (const action of [0, 1, 2, undefined]) {
		test(`RPC proposal changes auditor ${enabled} and handles decision ${action}`, async () => {
			const h = host([1, action]);
			const result = await showProposalDialog(h.ctx, "OBJECTIVE\nTasks: one, two\nContract: tests pass", "goal", enabled);
			assert.equal(result.auditorEnabled, !enabled);
			assert.equal(result.decision, action === 0 ? "confirm" : action === 2 ? "cancel" : "continue");
			assert.equal(result.unavailable, false);
			assert.match(h.dialogs[0]!.title, new RegExp(`currently ${enabled ? "enabled" : "disabled"}`));
			assert.match(h.dialogs[1]!.title, /OBJECTIVE[\s\S]*Tasks: one, two[\s\S]*Contract: tests pass/);
			assert.match(h.dialogs[1]!.title, new RegExp(`Auditor for this goal: ${enabled ? "disabled" : "enabled"}`));
		});
	}
}

test("auditor cancellation never presents or confirms the proposal", async () => {
	const h = host([undefined]);
	assert.equal((await showProposalDialog(h.ctx, "objective", "goal", false)).decision, "continue");
	assert.equal(h.dialogs.length, 1);
});

test("unknown host selections and failed primitives cannot confirm proposals", async () => {
	const h = host();
	h.ctx.ui.select = async () => "Confirm a made-up choice";
	await assert.rejects(showProposalDialog(h.ctx, "objective", "goal", true), /unknown auditor choice/);
	h.ctx.ui.select = async () => { throw new Error("Host disconnected"); };
	await assert.rejects(runGoalQuestionnaire(h.ctx, [question]), /Host disconnected/);
});
