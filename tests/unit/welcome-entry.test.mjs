// REQ-039: execute actual entry/form callbacks to cover all initialization paths.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const home = readFileSync(new URL('../../app/index.tsx', import.meta.url), 'utf8');
const form = readFileSync(new URL('../../src/components/server-connection-form.tsx', import.meta.url), 'utf8');
const start = home.indexOf('  useFocusEffect(', home.indexOf('function HomeScreen()'));
const focus = home.slice(start, home.indexOf('  useFocusEffect(', start + 1));
const save = form.slice(form.indexOf('  async function saveConnection()'), form.indexOf('\n  return (', form.indexOf('  async function saveConnection()')));

test('REQ-039 configured home initializes before loading real memos', async () => {
  const calls = [];
  let cleanup;
  vm.runInNewContext(focus, {
    useFocusEffect: (callback) => { cleanup = callback(); }, useCallback: (callback) => callback,
    initializeWelcomeMemo: async () => calls.push('initialize'),
    getMemos: async () => { calls.push('read'); return ['welcome']; },
    setMemos: (memos) => calls.push(...memos), setFeedback: () => assert.fail('unexpected failure'),
    hiddenMemoSession: { getSnapshot: () => ({ authenticating: false }) }, console,
  });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['initialize', 'read', 'welcome']);
  cleanup();
});

test('REQ-039 initialization failure is visible and prevents a false empty result', async () => {
  let failure;
  vm.runInNewContext(focus, {
    useFocusEffect: (callback) => callback(), useCallback: (callback) => callback,
    initializeWelcomeMemo: async () => { throw new Error('fixture failure'); },
    getMemos: async () => assert.fail('must not read after failed initialization'),
    setMemos: () => assert.fail('must not display a false empty result'),
    setFeedback: (feedback) => { failure = feedback; }, console: { error: () => {} },
  });
  await new Promise(setImmediate);
  assert.equal(failure.title, '无法加载记录');
  assert.match(failure.message, /初始化.*重试/);
});

test('REQ-039 successful connection saves and initializes before entering home', async () => {
  const calls = [];
  await vm.runInNewContext(`${save}\nsaveConnection()`, {
    setSaving: () => {}, verifyConnection: async () => ({ serverApiUrl: 'https://memo.example.com', apiKey: 'fixture-key' }),
    saveServerConnectionConfig: async () => calls.push('save'),
    initializeWelcomeMemo: async () => calls.push('initialize'),
    Keyboard: { dismiss: () => {} }, onConnected: () => calls.push('home'),
    showError: () => assert.fail('unexpected failure'),
  });
  assert.deepEqual(calls, ['save', 'initialize', 'home']);
});

test('REQ-039 failed verification does not save, initialize or enter home', async () => {
  await vm.runInNewContext(`${save}\nsaveConnection()`, {
    setSaving: () => {}, verifyConnection: async () => undefined,
    saveServerConnectionConfig: async () => assert.fail('unexpected save'),
    initializeWelcomeMemo: async () => assert.fail('unexpected initialization'),
    onConnected: () => assert.fail('unexpected home entry'),
    showError: () => assert.fail('unexpected second error'),
  });
});

test('REQ-039 welcome failure after save keeps the form open for retry', async () => {
  let failure;
  await vm.runInNewContext(`${save}\nsaveConnection()`, {
    setSaving: () => {}, verifyConnection: async () => ({ serverApiUrl: 'https://memo.example.com', apiKey: 'fixture-key' }),
    saveServerConnectionConfig: async () => {},
    initializeWelcomeMemo: async () => { throw new Error('fixture failure'); },
    onConnected: () => assert.fail('unexpected home entry'), showError: (message) => { failure = message; },
  });
  assert.match(failure, /欢迎笔记.*重试/);
});
