import test from "node:test";
import assert from "node:assert/strict";
import {TuiMainScreen} from "@earendil-works/pi-tui/dist/tui-main-screen.js";
import {stabilizationHarness, deferred} from "./stabilization-utils.ts";
import {createMockTheme} from "./tui-test-utils.ts";
import {mutateSettingsLayer} from "../extensions/goal-settings.ts";

for (const surface of ["dialog", "overlay", "foreign-editor"]) for (const mode of ["ordinary", "audit", "wait", "recovery"]) for (const pauseOrder of ["together", "goal-first", "turn-first"]) test(`all Goal shortcuts yield to ${surface} during ${mode}, ${pauseOrder}`, async () => {
 const pending = deferred<any>(), started = deferred<any>();
 const rejected = {approved: false, output: "More verification needed."};
 const h = stabilizationHarness(async () => {started.resolve(null); return pending.promise;});
 let completion: Promise<any> | undefined;
 let input!: (data: string) => void;
 const terminal: any = {columns: 100, rows: 30, kittyProtocolActive: true, start: (onInput: typeof input) => {input = onInput;}, stop() {}, write() {}, hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}};
 const tui = new TuiMainScreen(terminal);
 const received: string[] = [];
 // Pi publicly wires app.clear and onSubmit onto its main CustomEditor, including replacements.
 const editor = {render: () => [], invalidate() {}, handleInput() {}, onSubmit() {}, actionHandlers: new Map([["app.clear", () => {}]])};
 const foreign = {render: () => [], invalidate() {}, handleInput: (data: string) => received.push(data), ...(surface === "foreign-editor" ? {getText: () => "", setText() {}} : {})};
 let commands = 0, aborts = 0;
 try {
  mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["keybindings", "pause"], value: "f6"}});
  mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["keybindings", "commands", "goal-status"], value: "f8"}});
  mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["pauseOrder"], value: pauseOrder}});
  mutateSettingsLayer({scope: "project", cwd: h.cwd, mutation: {op: "set", path: ["strictExecutionContract"], value: true}});
  h.ctx.abort = () => {aborts++;};
  h.core.invokeGoalCommand = async () => {commands++;};
  h.ctx.hasUI = true;
  h.ctx.ui.setWidget = (_key: string, factory: any) => {if (typeof factory === "function") factory(tui, createMockTheme());};
  h.ctx.ui.onTerminalInput = (listener: any) => tui.addInputListener(listener);
  tui.addChild(editor); tui.setFocus(editor); tui.start();
  await h.start();
  h.core.updateFocusedGoal({...h.core.state.goal!, autoContinue: true}, h.ctx);
  if (mode === "audit") {completion = h.call("update_goal", {status: "complete"}); await started.promise;}
  if (mode === "wait") {
   h.core.scheduler.begin(h.ctx);
   assert.equal(h.core.scheduler.declare(h.ctx, {kind: "wait", reason: "External producer", deadline: new Date(Date.now() + 60000).toISOString()}).terminate, true);
   assert.equal(h.core.state.goal?.scheduler?.phase, "waiting");
  }
  if (mode === "recovery") assert.ok(h.core.runtime.scheduleNetworkErrorRetry(h.ctx, h.core.state.goal!));
  const audit = h.core.activeAudit, progress = h.core.auditProgress, animation = h.core.auditAnimationTimer;
  const before = h.disk(), state = structuredClone(h.core.state.goal), ledger = h.ledger();
  const handle = surface === "overlay" ? tui.showOverlay(foreign) : undefined;
  if (!handle) tui.setFocus(foreign);
  const expanded = h.core.isDashboardExpanded();
  for (const key of ["\x1b[19~", "\x1b", "\x1b[17~", "\x1b[84;6u", "\x1b[65;6u", "\x1b[88;6u", "\x1b[17;1:2~", "\x1b[17;1:3~"]) input(key);
  assert.ok(received.includes("\x1b") && received.includes("\x1b[17~"), "focused surface receives ordinary keys");
  assert.equal(h.disk(), before);
  assert.deepEqual(h.core.state.goal, state);
  assert.deepEqual(h.ledger(), ledger);
  assert.equal(h.core.isDashboardExpanded(), expanded);
  assert.equal(h.core.activeAudit, audit);
  assert.equal(h.core.auditProgress, progress);
  assert.equal(h.core.auditAnimationTimer, animation);
  assert.equal(audit?.controller.signal.aborted ?? false, false);
  assert.equal(h.core.interruption.isHeld(), false);
  assert.equal(aborts, 0);
  if (mode === "recovery") assert.equal(h.core.runtime.scheduleNetworkErrorRetry(h.ctx, h.core.state.goal!), null, "foreign keys did not cancel recovery");
  assert.equal(commands, 0);
  handle?.hide(); tui.setFocus(editor);
  pending.resolve(rejected); await completion;
  const passive = tui.showOverlay(foreign, {nonCapturing: true});
  assert.equal(tui.getFocusedComponent(), editor);
  input("\x1b[17~");
  if (pauseOrder === "turn-first") {
   assert.equal(h.core.state.goal?.status, "active");
   assert.equal(h.core.interruption.isHeld(), true);
   input("\x1b[17~");
  }
  assert.equal(h.core.state.goal?.status, "paused", "main editor keeps pause while a non-capturing overlay is visible");
  passive.hide();
  h.core.clearGoalWidget(h.ctx); h.core.updateUI(h.ctx);
  input("\x1b[84;6u");
  assert.equal(h.core.isDashboardExpanded(), !expanded, "widget recreation keeps editor controls usable");
 } finally {pending.resolve(rejected); await completion; await h.cleanup(); tui.stop();}
});
