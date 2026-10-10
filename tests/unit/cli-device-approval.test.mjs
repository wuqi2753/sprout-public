// REQ-096: authenticated query/decision, validation and uncertain outcomes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(fetch) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL('../../src/api/cli-device-approval.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(`(function(require,exports){${source}})`, { URL, Date, AbortController, setTimeout, clearTimeout, fetch })((name) => {
    assert.equal(name, './server-connection');
    return { normalizeServerApiUrl: (value) => value };
  }, exports);
  return exports;
}
const config = { serverApiUrl: 'https://notes.example.com', apiKey: 'test-key' };
const fields = { user_code: 'ABCD-1234', client_id: 'sprout-cli', scope: 'notes:read subscriptions:manage', expires_at: '2099-01-01T00:00:00Z', status: 'pending' };
test('query uses saved credentials, decision sends exact body, terminal states are explicit', async () => {
  const calls = [];
  const api = load(async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ ...fields, status: options.method === 'POST' ? JSON.parse(options.body).decision === 'approve' ? 'approved' : 'denied' : 'pending' })); });
  const signal = new AbortController().signal;
  const pending = await api.requestCliApproval(config, fields.user_code, signal);
  assert.equal(pending.status, 'pending');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].options.redirect, 'error');
  for (const decision of ['approve', 'deny']) {
    const result = await api.requestCliApproval(config, fields.user_code, signal, decision);
    assert.match(api.cliRequestStatusMessage(result), decision === 'approve' ? /批准/ : /拒绝/);
    assert.equal(calls.at(-1).url, `${config.serverApiUrl}/oauth/device_requests/ABCD-1234/decision`);
    assert.equal(calls.at(-1).options.body, JSON.stringify({ decision }));
  }
});
test('reject unknown permissions, mismatched code/client, invalid deadline and status', () => {
  const api = load();
  for (const change of [{ scope: 'notes:write' }, { scope: 'notes:read notes:read' }, { user_code: 'WXYZ-9876' }, { client_id: 'other' }, { expires_at: 'invalid' }, { status: 'other' }]) {
    assert.throws(() => api.validateCliRequest({ ...fields, ...change }, fields.user_code));
  }
  for (const status of ['approved', 'denied', 'consumed', 'expired']) assert.ok(api.cliRequestStatusMessage(api.validateCliRequest({ ...fields, status }, fields.user_code)));
  assert.match(api.cliRequestStatusMessage(api.validateCliRequest({ ...fields, expires_at: '2000-01-01T00:00:00Z' }, fields.user_code)), /过期/);
});
test('HTTP failures and ambiguous approval never report success', async () => {
  for (const status of [401, 404, 409, 410, 500]) {
    const api = load(async () => new Response('{}', { status }));
    await assert.rejects(api.requestCliApproval(config, fields.user_code, new AbortController().signal), /凭据|不存在|状态|过期|失败/);
  }
  for (const fetch of [async () => { throw new Error('secret transport detail'); }, async () => new Response('invalid'), async () => new Response(JSON.stringify(fields))]) {
    const api = load(fetch);
    await assert.rejects(api.requestCliApproval(config, fields.user_code, new AbortController().signal, 'approve'), (error) => error.uncertain === true && !error.message.includes('secret'));
  }
});
test('invalid code or credentials fail before network; cancellation signal propagates', async () => {
  let called = false;
  const api = load(async (_, options) => { called = true; assert.ok(options.signal.aborted); throw new Error('aborted'); });
  await assert.rejects(api.requestCliApproval(config, 'bad', new AbortController().signal));
  await assert.rejects(api.requestCliApproval({ ...config, apiKey: '' }, fields.user_code, new AbortController().signal));
  assert.equal(called, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.requestCliApproval(config, fields.user_code, controller.signal));
});
