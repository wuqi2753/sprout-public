// REQ-074: actual scanner and form callback outcomes, not a parallel implementation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { connectionCallbacks } from '../fixtures/connection-callbacks.mjs';

const formCallbacks = connectionCallbacks('server-connection-form.tsx', ['ConnectionSetupError', 'verifyConnection', 'saveConnection']);
const scannerCallbacks = connectionCallbacks('server-qr-scanner.tsx', ['scan', 'confirmScan']);
const incoming = { serverApiUrl: 'https://new.example.com', apiKey: 'new-fixture-key' };

function apiModule(filename, dependencies = {}, globals = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL(`../../src/api/${filename}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(require, exports) { ${compiled} })`, { URL, Error, AbortController, setTimeout, clearTimeout, Date, ...globals })((name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

function setup(options = {}) {
  const calls = [];
  let stored = { serverApiUrl: 'https://old.example.com', apiKey: 'old-fixture-key' };
  const fields = {};
  const api = apiModule('server-connection', {}, { fetch: async (url, request) => {
    calls.push({ action: 'health', url, authorization: request.headers.Authorization });
    if (options.fetch) return options.fetch();
    return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  } });
  const context = vm.createContext({
    ...api, Error, connectionPending: { current: false }, connectionSession: { current: 1 }, connecting: false,
    serverApiUrl: stored.serverApiUrl, apiKey: stored.apiKey,
    setSaving: () => {}, setConnecting: () => {},
    setServerApiUrl: (value) => { fields.serverApiUrl = value; },
    setApiKey: (value) => { fields.apiKey = value; }, setManualVisible: () => {},
    saveServerConnectionConfig: async (config) => {
      calls.push({ action: 'save' });
      if (options.saveError) throw new Error(`private storage error: ${incoming.apiKey}`);
      stored = config;
    },
    initializeWelcomeMemo: async () => {
      calls.push({ action: 'welcome' });
      if (options.welcomeError) throw new Error('fixture initialization failure');
    },
    Keyboard: { dismiss: () => {} }, onConnected: () => calls.push({ action: 'home' }),
    showError: () => assert.fail('scanned errors must be returned to scanner'),
  });
  vm.runInContext(formCallbacks, context);
  return { context, calls, fields, api, stored: () => stored, connect: () => vm.runInContext('saveConnection(scanned)', Object.assign(context, { scanned: incoming })) };
}

test('scan populates credentials; explicit confirmation verifies, saves and enters home', async () => {
  const flow = setup();
  const qrApi = apiModule('server-qr', { './server-connection': flow.api });
  const scanner = vm.createContext({
    ...qrApi, Error, scanLocked: { current: false }, confirmationPending: { current: false },
    serverUrl: undefined, connected: false, allowPairing: true,
    setQr: (qr) => { scanner.qr = qr; }, setMessage: () => assert.fail('unexpected scanner error'),
    setConnecting: () => {}, onConnect: (config) => { assert.deepEqual({ ...config }, incoming); return flow.connect(); },
    onClose: () => flow.calls.push({ action: 'close' }), Date,
    encoded: JSON.stringify({ version: 1, type: 'pairing', server_url: incoming.serverApiUrl, api_key: incoming.apiKey }),
  });
  vm.runInContext(scannerCallbacks, scanner);
  vm.runInContext('scan(encoded); scan(encoded)', scanner);
  assert.equal(flow.calls.length, 0);
  assert.equal(scanner.qr.apiKey, incoming.apiKey);
  await vm.runInContext('confirmScan()', scanner);
  assert.deepEqual(flow.calls.map((call) => call.action), ['health', 'save', 'welcome', 'home', 'close']);
  assert.equal(flow.calls[0].url, `${incoming.serverApiUrl}/api/v1/health`);
  assert.equal(flow.calls[0].authorization, `Bearer ${incoming.apiKey}`);
  assert.deepEqual({ ...flow.stored() }, incoming);
  assert.deepEqual(flow.fields, incoming);
});

for (const savedUrl of [undefined, 'https://old.example.com']) test(`scan with saved URL ${savedUrl} populates form once without requesting or saving`, () => {
  const flow = setup();
  const qrApi = apiModule('server-qr', { './server-connection': flow.api });
  const populated = [];
  const scanner = vm.createContext({
    ...qrApi, Error, scanLocked: { current: false }, serverUrl: savedUrl,
    connected: Boolean(savedUrl), allowPairing: true,
    onReadConnection: (config) => populated.push({ ...config }),
    setQr: () => assert.fail('unpaired scan should open the form'),
    setMessage: () => assert.fail('valid connection QR should not fail'),
    encoded: JSON.stringify({ version: 1, type: 'pairing', server_url: incoming.serverApiUrl, api_key: incoming.apiKey }),
  });
  vm.runInContext(scannerCallbacks, scanner);
  vm.runInContext('scan(encoded); scan(encoded)', scanner);
  assert.deepEqual(populated, [incoming]);
  assert.deepEqual(flow.calls, []);
  assert.equal(flow.stored().apiKey, 'old-fixture-key');
});

test('authentication and network failures keep original config and do not initialize or navigate', async () => {
  for (const fetch of [async () => ({ status: 401 }), async () => { throw new Error(`network fixture ${incoming.apiKey}`); }]) {
    const flow = setup({ fetch });
    await assert.rejects(flow.connect(), (error) => !error.message.includes(incoming.apiKey));
    assert.equal(flow.stored().apiKey, 'old-fixture-key');
    assert.deepEqual(flow.calls.map((call) => call.action), ['health']);
    assert.equal(flow.context.connectionPending.current, false);
  }
});

test('save and welcome failures are visible and do not enter home', async () => {
  for (const options of [{ saveError: true }, { welcomeError: true }]) {
    const flow = setup(options);
    await assert.rejects(flow.connect(), (error) => !error.message.includes(incoming.apiKey));
    assert.equal(flow.calls.some((call) => call.action === 'home'), false);
    assert.equal(flow.context.connectionPending.current, false);
  }
});

test('duplicate confirmation starts one connection and validation completed after exit cannot save', async () => {
  let release;
  const flow = setup({ fetch: () => new Promise((resolve) => { release = resolve; }) });
  const first = flow.connect();
  await assert.rejects(flow.connect(), /稍候/);
  flow.context.connectionSession.current++;
  release({ ok: true, status: 200, json: async () => ({ status: 'ok' }) });
  await assert.rejects(first, /关闭/);
  assert.deepEqual(flow.calls.map((call) => call.action), ['health']);
  assert.equal(flow.stored().apiKey, 'old-fixture-key');
});

test('unconfirmed scan and daily scan of another connection never send credentials', () => {
  const flow = setup();
  const qrApi = apiModule('server-qr', { './server-connection': flow.api });
  let message;
  const scanner = vm.createContext({
    ...qrApi, Error, scanLocked: { current: false }, serverUrl: 'https://old.example.com', connected: true, allowPairing: false,
    setQr: () => assert.fail('daily scan must not switch connection'), setMessage: (value) => { message = value; },
    encoded: JSON.stringify({ version: 1, type: 'pairing', server_url: incoming.serverApiUrl, api_key: incoming.apiKey }),
  });
  vm.runInContext(scannerCallbacks, scanner);
  vm.runInContext('scan(encoded)', scanner);
  assert.match(message, /设置/);
  assert.equal(flow.calls.length, 0);
});

test('scanner exposes authentication failure without closing or leaking credentials', async () => {
  const flow = setup({ fetch: async () => ({ status: 401 }) });
  const qrApi = apiModule('server-qr', { './server-connection': flow.api });
  let message;
  const scanner = vm.createContext({
    ...qrApi, Error, Date, confirmationPending: { current: false },
    qr: { type: 'pairing', serverUrl: incoming.serverApiUrl, apiKey: incoming.apiKey },
    serverUrl: undefined, connected: false, allowPairing: true,
    setQr: () => {}, setConnecting: () => {}, setMessage: (value) => { message = value; },
    onConnect: () => flow.connect(), onClose: () => assert.fail('failed connection must remain open'),
  });
  vm.runInContext(scannerCallbacks, scanner);
  await vm.runInContext('confirmScan()', scanner);
  assert.match(message, /API Key 无效/);
  assert.equal(message.includes(incoming.apiKey), false);
  assert.equal(flow.stored().apiKey, 'old-fixture-key');
});

test('CLI confirmation remains a placeholder and never passes credentials to connection callback', async () => {
  let message;
  const flow = setup();
  const qrApi = apiModule('server-qr', { './server-connection': flow.api });
  const scanner = vm.createContext({
    ...qrApi, Error, Date, confirmationPending: { current: false },
    qr: { type: 'cli', serverUrl: 'https://old.example.com', userCode: 'ABCD-1234', expiresAt: Date.now() + 60000 },
    serverUrl: 'https://old.example.com', connected: true, allowPairing: true,
    setQr: () => {}, setConnecting: () => {}, setMessage: (value) => { message = value; },
    onConnect: () => assert.fail('CLI must not save connection credentials'),
    onClose: () => assert.fail('unimplemented CLI approval must not appear successful'),
  });
  vm.runInContext(scannerCallbacks, scanner);
  await vm.runInContext('confirmScan()', scanner);
  assert.match(message, /尚未接入/);
  assert.equal(flow.calls.length, 0);
});

const replacementCallbacks = connectionCallbacks('server-connection-form.tsx', ['requestConnection', 'confirmReplacement']);
test('replacement requires confirmation and passes only new credentials', async () => {
  let pending; const calls = [];
  const context = vm.createContext({ Error, connectionPending: { current: false }, connecting: false, saving: false, savedConnection: { current: { serverApiUrl: 'https://old.example.com', apiKey: 'old-key' } }, serverApiUrl: incoming.serverApiUrl, apiKey: incoming.apiKey, setReplacement: (config) => { pending = config; context.replacement = config; }, saveConnection: async (config) => calls.push({ ...config }), showError: () => assert.fail('unexpected error') });
  vm.runInContext(replacementCallbacks, context);
  vm.runInContext('requestConnection()', context);
  assert.deepEqual({ ...pending }, incoming); assert.deepEqual(calls, []);
  context.replacement = undefined;
  await vm.runInContext('confirmReplacement()', context);
  assert.deepEqual(calls, []);
  vm.runInContext('requestConnection()', context);
  await vm.runInContext('confirmReplacement()', context);
  assert.deepEqual(calls, [incoming]);
});
