// REQ-072: QR boundaries and connection guards; tests never send credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../../src/api/server-qr.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
const connectionCompiled = ts.transpileModule(readFileSync(new URL('../../src/api/server-connection.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const connectionExports = {};
vm.runInNewContext(`(function(exports) { ${connectionCompiled} })`, { URL })(connectionExports);
vm.runInNewContext(`(function(require, exports) { ${compiled} })`, { URL, Date })((name) => {
  assert.equal(name, './server-connection');
  return connectionExports;
}, exports);
const { parseServerQr, validateQrConnection } = exports;
const now = Date.parse('2026-10-09T00:00:00Z');
const payload = { version: 1, type: 'pairing', server_url: 'https://memo.example.com', api_key: 'test-connection-key' };
const parse = (changes = {}) => parseServerQr(JSON.stringify({ ...payload, ...changes }), now);
test('REQ-074 connection parser preserves Key without an expiry', () => {
  const qr = parse();
  assert.equal(qr.type, 'pairing');
  assert.equal(qr.serverUrl, payload.server_url);
  assert.equal(qr.apiKey, payload.api_key);
  assert.equal(qr.expiresAt, undefined);
  assert.doesNotThrow(() => validateQrConnection(qr, undefined, false, false));
  assert.throws(() => validateQrConnection(qr, payload.server_url, true, false), /设置/);
  assert.doesNotThrow(() => validateQrConnection(qr, payload.server_url, true, true));
});
test('reject malformed, expired, secret-bearing, unsupported and unsafe QR', () => {
  for (const text of ['null', '[]', '{}', 'not json', 'x'.repeat(4097)]) assert.throws(() => parseServerQr(text, now));
  for (const changes of [{version: 2}, {type: 'other'}, {expires_at: 'invalid'}, {expires_at: '2026-10-09T00:00:00Z'}, {api_key: ''}, {api_key: 'a b'}, {api_key: 'x'.repeat(513)}, {api_key: '私密'}, {api_key: null}, {pairing_token: 'old-secret'}, {server_url: 'https://localhost'}, {server_url: 'https://127.0.0.1'}, {server_url: 'https://memo.example.com:8080'}, {server_url: 'https://memo.example.com/api/v1'}, {server_url: 'https://memo.example.com/../'}, {server_url: 'https://memo.example.com?'}, {server_url: 'https://memo.example.com#'}, {device_code: 'secret'}, {access_token: 'secret'}, {server_url: 'http://memo.example.com'}, {server_url: ['https:', '//user:secret', '@', 'memo.example.com'].join('')}, {server_url: 'https://memo.example.com?key=x'}, {server_url: 'https://memo.example.com#key'}]) assert.throws(() => parse(changes));
});
test('CLI approval requires saved reachable server with exact origin and base path', () => {
  const { api_key: omitted, ...cli } = payload;
  const qr = parseServerQr(JSON.stringify({ ...cli, type: 'cli', server_url: 'https://memo.example.com/base', user_code: 'ABCD-1234', expires_at: '2026-10-09T00:30:00Z' }), now);
  assert.equal(qr.userCode, 'ABCD-1234');
  assert.throws(() => validateQrConnection(qr, undefined, false, false), /先连接/);
  for (const server of ['https://evil.example.com/base', 'https://memo.example.com:8443/base', 'https://memo.example.com/other', 'https://memo.example.com']) assert.throws(() => validateQrConnection(qr, server, true, false), /其他 Server/);
  assert.throws(() => validateQrConnection(qr, qr.serverUrl, false, false), /重试/);
  assert.doesNotThrow(() => validateQrConnection(qr, `${qr.serverUrl}/`, true, false));
});

test('CLI rejects expired or missing deadline and embedded Key', () => {
  const cli = { version: 1, type: 'cli', server_url: payload.server_url, user_code: 'ABCD-1234', expires_at: '2026-10-09T00:30:00Z' };
  for (const changes of [{ expires_at: undefined }, { expires_at: '2026-10-09T00:00:00Z' }, { api_key: payload.api_key }]) {
    assert.throws(() => parseServerQr(JSON.stringify({ ...cli, ...changes }), now));
  }
});
