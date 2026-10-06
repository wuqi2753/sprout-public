// REQ-045: Reject unsafe destinations before transmitting credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadApi(name, dependencies, fetch) {
  const source = readFileSync(new URL(`../../src/api/${name}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(require, exports) { ${compiled}\n})`, { URL, fetch, AbortController, setTimeout, clearTimeout })((name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

test('REQ-045 permits HTTPS and literal 127.0.0.1 HTTP only', () => {
  const api = loadApi('server-connection', {}, () => { throw new Error('Unexpected request'); });
  for (const address of ['https://memo.example.com', 'https://memo.example.com:8443/api', 'http://127.0.0.1:8080', 'http://127.0.0.1/api']) {
    assert.equal(api.normalizeServerApiUrl(address), address);
  }
  for (const address of ['https://203.0.113.10:8443/api', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://bad_host.example.com', 'https://-bad.example.com', 'https://bad-.example.com', 'https://memo..example.com']) {
    assert.throws(() => api.normalizeServerApiUrl(address), /有效域名/);
  }
  for (const address of ['203.0.113.10:8080', 'memo.example.com']) {
    assert.throws(() => api.normalizeServerApiUrl(address), { kind: 'url' });
  }
  for (const address of ['http://example.com', 'http://203.0.113.10:8080', 'http://203.0.113.10', 'http://localhost:8080', 'http://[::1]:8080', 'http://203.0.113.10', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://127.0.0.1.example.com', ['http://127.0.0.1', 'evil.invalid'].join('@'), 'https://' + ['user:secret', 'example.com'].join('@'), 'https://example.com?key=secret', 'https://example.com#fragment']) {
    assert.throws(() => api.normalizeServerApiUrl(address), { kind: 'url' });
  }
});

test('REQ-045 probe and every sync operation reject unsafe stored URLs before fetch', async () => {
  let requests = 0;
  const fetch = async () => { requests++; throw new Error('Unexpected request'); };
  const api = loadApi('server-connection', {}, fetch);
  const sync = loadApi('memo-sync', { '@/api/server-connection': api }, fetch);
  const config = { serverApiUrl: 'http://example.com', apiKey: 'private-key' };
  for (const operation of [
    () => api.probeServerConnection(config),
    () => sync.sendMemoOperation(config, { operation: 'create', memoId: 'note', operationId: 'op', content: 'secret' }),
    () => sync.getAppliedOperationVersion(config, 'op'),
    () => sync.uploadMemoImage(config, 'image', 'image/png', new ArrayBuffer(1)),
    () => sync.uploadMemoFile(config, { id: 'file', media_type: 'application/pdf' }, new ArrayBuffer(1)),
  ]) await assert.rejects(operation(), { kind: 'url' });
  assert.equal(requests, 0);
});

test('REQ-045 authenticated requests disable automatic redirects', async () => {
  const requests = [];
  const fetch = async (_url, options) => {
    requests.push(options);
    return { ok: true, json: async () => ({ status: 'ok', version: 1 }) };
  };
  const api = loadApi('server-connection', {}, fetch);
  const sync = loadApi('memo-sync', { '@/api/server-connection': api }, fetch);
  const config = { serverApiUrl: 'https://example.com', apiKey: 'test' };
  await api.probeServerConnection(config);
  await sync.sendMemoOperation(config, { operation: 'create', memoId: 'note', operationId: 'op' });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.redirect === 'error'));
});
