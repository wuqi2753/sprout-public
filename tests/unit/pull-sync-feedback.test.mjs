// REQ-051: Exercise the actual home gesture and synchronization callbacks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../app/index.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let syncSource, gestureSource;
function collect(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'refreshAndSync') syncSource = node.getText(parsed);
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'refreshGesture') gestureSource = node.initializer.getText(parsed);
  ts.forEachChild(node, collect);
}
collect(parsed);
function setup(connectionStatus = 'connected') {
  const events = [], callbacks = {};
  const gesture = new Proxy({}, { get: (_, name) => (...args) => { if (name.startsWith('on')) callbacks[name] = args[0]; return gesture; } });
  const context = vm.createContext({
    connectionStatus, searchVisible: false, refreshingRef: { current: false }, refreshStartedAtTop: { current: false },
    scrollOffsetY: { current: 0 }, scrollGesture: {}, refreshAndSyncRef: { current: null },
    pullOffset: { setValue: (value) => events.push(['offset', value]), stopAnimation() {} },
    Animated: { spring: () => ({ start: () => events.push(['rebound']) }) },
    Gesture: { Pan: () => gesture }, useMemo: (callback) => callback(),
    setRefreshing: (value) => events.push(['refreshing', value]), setSyncFeedback: (value) => events.push(['feedback', value]),
    setMemos: (value) => events.push(['memos', value]), getMemos: async () => ['updated'],
    syncMemoOutbox: async () => events.push(['sync']), showStorageError: () => {}, console: { error() {} },
  });
  const compiled = ts.transpileModule(`${syncSource}\nconst gesture = ${gestureSource};\nrefreshAndSyncRef.current = refreshAndSync;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(compiled, context);
  return { context, events, callbacks };
}
test('REQ-051 pull threshold, list position and cancel preserve request semantics', () => {
  const { callbacks, context, events } = setup();
  let calls = 0; context.refreshAndSyncRef.current = () => calls++;
  callbacks.onBegin(); callbacks.onUpdate({ translationY: 60 }); callbacks.onEnd({ translationY: 60 });
  assert.equal(calls, 0); assert.ok(events.some(([name]) => name === 'rebound'));
  callbacks.onBegin(); callbacks.onEnd({ translationY: 70 }); assert.equal(calls, 1);
  context.scrollOffsetY.current = 10;
  callbacks.onBegin(); callbacks.onEnd({ translationY: 100 }); assert.equal(calls, 1);
  context.refreshingRef.current = true;
  const eventCount = events.length;
  callbacks.onBegin(); callbacks.onEnd({ translationY: 100 }); callbacks.onFinalize();
  assert.equal(calls, 1); assert.equal(events.length, eventCount);
  context.refreshingRef.current = false;
  callbacks.onFinalize(); assert.equal(context.refreshStartedAtTop.current, false);
});
test('REQ-051 concurrent pulls synchronize once and restore title state on success', async () => {
  const { context, events } = setup(); let release;
  context.syncMemoOutbox = () => new Promise((resolve) => { release = resolve; events.push(['sync']); });
  const pending = context.refreshAndSync(); await context.refreshAndSync();
  assert.equal(events.filter(([name]) => name === 'sync').length, 1);
  assert.equal(context.refreshingRef.current, true);
  release(); await pending;
  assert.equal(context.refreshingRef.current, false);
  assert.deepEqual(events.filter(([name]) => name === 'refreshing'), [['refreshing', true], ['refreshing', false]]);
  assert.ok(events.some(([name]) => name === 'memos'));
});
test('REQ-051 failures and disconnected pulls rebound without stuck synchronization', async () => {
  const disconnected = setup('unconfigured'); await disconnected.context.refreshAndSync();
  assert.equal(disconnected.events.some(([name]) => name === 'sync'), false);
  assert.ok(disconnected.events.some(([name]) => name === 'feedback'));
  const failed = setup(); failed.context.syncMemoOutbox = async () => { throw new Error('network'); };
  await failed.context.refreshAndSync();
  assert.equal(failed.context.refreshingRef.current, false);
  assert.ok(failed.events.some(([name]) => name === 'feedback'));
  assert.ok(failed.events.some(([name]) => name === 'rebound'));
});
