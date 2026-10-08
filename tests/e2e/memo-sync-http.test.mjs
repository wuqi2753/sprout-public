import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import typescript from 'typescript';

import { synchronizeMemoOutbox } from '../../.tmp/test-build/memo-outbox-core.js';

const require = createRequire(import.meta.url);
const compiledDirectory = mkdtempSync(join(process.cwd(), '.tmp', 'memo-sync-http-'));
for (const name of ['server-connection', 'memo-sync']) {
  const source = readFileSync(new URL(`../../src/api/${name}.ts`, import.meta.url), 'utf8')
    .replace("from '@/api/server-connection'", "from './server-connection'");
  const compiled = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(compiledDirectory, `${name}.js`), compiled);
}
const { probeServerConnection } = require(join(compiledDirectory, 'server-connection.js'));
// REQ-069: verify the actual Outbox -> HTTP PATCH timestamp contract.
test('REQ-069 Outbox time correction reaches PATCH with seconds and version', async (t) => {
  let patch;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    patch = { method: request.method, body: JSON.parse(Buffer.concat(chunks).toString()) };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: 2 }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let acknowledged;
  await synchronizeMemoOutbox({
    recoverSendingOperations: async () => {},
    getPendingOperations: async () => [{ operationId: 'time-op', memoId: 'memo', operation: 'update', attemptCount: 0,
      payload: JSON.stringify({ content: 'original', created_at: '2024-02-29T15:59:47.000Z' }) }],
    markSending: async () => {}, getLastServerVersion: async () => 1,
    sendMemoOperation: (operation) => sendMemoOperation({ serverApiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key' }, operation),
    markAcknowledged: async (_, version) => { acknowledged = version; },
    markFailed: async (_, failure) => { throw new Error(`Unexpected sync failure: ${JSON.stringify(failure)}`); },
    classifyFailure: (error) => ({ message: error.message }),
  });
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.body.created_at, '2024-02-29T15:59:47.000Z');
  assert.equal(patch.body.base_version, 1);
  assert.equal(acknowledged, 2);
});
const { getAppliedOperationVersion, sendMemoOperation, uploadMemoImage, uploadMemoFile, fetchActiveMemos, fetchTrashMemos, fetchServerMemo, MemoSyncError } = require(join(compiledDirectory, 'memo-sync.js'));

test('REQ-065/066 mock E2E: delete, lost response, cross-device trash, restore and 30-day expiry', async (t) => {
  const memoId = '018f4b64-8be1-7ee2-b608-9d26c750f57a';
  let clock = new Date('2026-10-07T12:00:00.000Z');
  let memo;
  let deleteApplies = 0;
  let loseDeleteResponse = true;
  const processed = new Map();
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== 'Bearer trash-key') {
      response.writeHead(401).end(JSON.stringify({ error: { code: 'invalid_api_key' } }));
      return;
    }
    const send = (status, value) => response.writeHead(status).end(JSON.stringify(value));
    const key = request.headers['idempotency-key'];
    if (key && processed.has(key)) { send(200, processed.get(key).body); return; }
    if (request.method === 'GET' && request.url.startsWith('/api/v1/sync/operations/')) {
      const result = processed.get(request.url.split('/').at(-1));
      send(result ? 200 : 404, result
        ? { operation_id: request.url.split('/').at(-1), note_id: memoId, operation: result.operation, status: 'applied', result_version: result.body.version }
        : { error: { code: 'operation_not_found' } });
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/notes') {
      send(200, { notes: memo && !memo.deleted_at ? [memo] : [] }); return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/trash') {
      send(200, { notes: memo?.deleted_at && clock < new Date(memo.expires_at) ? [memo] : [] }); return;
    }
    if (request.method === 'GET' && request.url === `/api/v1/notes/${memoId}`) {
      send(memo ? 200 : 404, memo ?? { error: { code: 'note_not_found' } }); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.method === 'POST' && request.url === '/api/v1/notes') {
      memo = { note_id: memoId, content: body.content, images: [], files: [], file_attachments: [],
        version: 1, created_at: body.created_at, updated_at: clock.toISOString(), deleted_at: null, expires_at: null };
      processed.set(key, { operation: 'create', body: { ...memo } });
      send(201, memo); return;
    }
    if (body.base_version !== memo?.version) { send(409, { error: { code: 'version_conflict' } }); return; }
    if (request.method === 'DELETE' && request.url === `/api/v1/notes/${memoId}`) {
      deleteApplies++;
      memo = { ...memo, version: memo.version + 1, updated_at: clock.toISOString(), deleted_at: clock.toISOString(),
        expires_at: new Date(clock.getTime() + 30 * 86400_000).toISOString() };
      processed.set(key, { operation: 'delete', body: { ...memo } });
      if (loseDeleteResponse) { loseDeleteResponse = false; request.socket.destroy(); return; }
      send(200, memo); return;
    }
    if (request.method === 'POST' && request.url === `/api/v1/notes/${memoId}/restore`) {
      if (clock >= new Date(memo.expires_at)) { send(410, { error: { code: 'note_expired' } }); return; }
      memo = { ...memo, version: memo.version + 1, deleted_at: null, expires_at: null, updated_at: clock.toISOString() };
      processed.set(key, { operation: 'restore', body: { ...memo } });
      send(200, memo); return;
    }
    send(404, { error: { code: 'not_found' } });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { serverApiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'trash-key' };
  const operations = [];
  let version;
  const dependencies = {
    recoverSendingOperations: async () => {},
    getPendingOperations: async () => operations.filter((row) => row.state !== 'acked'),
    markSending: async (id) => { operations.find((row) => row.operationId === id).state = 'sending'; },
    getLastServerVersion: async () => version,
    getAppliedOperationVersion: (id, noteId, operation) => getAppliedOperationVersion(config, id, { memoId: noteId, operation }),
    sendMemoOperation: (operation) => sendMemoOperation(config, operation),
    markAcknowledged: async (id, resultVersion) => { operations.find((row) => row.operationId === id).state = 'acked'; version = resultVersion; },
    markFailed: async (row, failure) => { row.state = failure.retryable ? 'retryable_failed' : 'permanent_failed'; row.attemptCount++; },
    classifyFailure: (error) => ({ retryable: error instanceof MemoSyncError && error.retryable, message: String(error) }),
  };
  const queue = (operation, suffix, payload) => operations.push({ operationId: `0199a633-67aa-7e58-97f8-0196e3684b${suffix}`, memoId,
    operation, payload: JSON.stringify(payload), attemptCount: 0, state: 'pending' });
  queue('create', 'a1', { content: '可恢复的想法', created_at: '2026-10-01T00:00:00Z' });
  await synchronizeMemoOutbox(dependencies);
  assert.equal(version, 1);
  queue('delete', 'a2', {});
  await synchronizeMemoOutbox(dependencies);
  assert.equal(operations.at(-1).state, 'retryable_failed');
  clock = new Date('2026-10-08T12:00:00.000Z');
  await synchronizeMemoOutbox(dependencies);
  assert.equal(operations.at(-1).state, 'acked');
  assert.equal(deleteApplies, 1);
  assert.equal((await fetchTrashMemos(config))[0].expires_at, '2026-11-06T12:00:00.000Z');
  assert.deepEqual(await fetchActiveMemos(config), []);
  queue('restore', 'a3', {});
  await synchronizeMemoOutbox(dependencies);
  assert.equal(version, 3);
  assert.equal((await fetchActiveMemos(config))[0].note_id, memoId);
  assert.deepEqual(await fetchTrashMemos(config), []);
  clock = new Date('2026-10-09T12:00:00.000Z');
  queue('delete', 'a4', {});
  await synchronizeMemoOutbox(dependencies);
  clock = new Date('2026-11-08T12:00:00.000Z');
  assert.deepEqual(await fetchTrashMemos(config), []);
  await assert.rejects(sendMemoOperation(config, { operationId: '0199a633-67aa-7e58-97f8-0196e3684ba5', memoId, operation: 'restore', baseVersion: 4 }),
    { statusCode: 410, retryable: false });
  assert.equal((await fetchServerMemo(config, memoId)).version, 4);
});

test('REQ-066 rejects malformed remote attachment metadata before local download', async (t) => {
  const memo = { note_id: '018f4b64-8be1-7ee2-b608-9d26c750f57a', content: 'file', images: [], files: ['note:file'],
    file_attachments: [{ id: 'note:file', name: 'report.pdf', media_type: 'application/pdf', size: -1, sha256: 'invalid' }],
    version: 2, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
    deleted_at: '2026-10-02T00:00:00Z', expires_at: '2026-11-01T00:00:00Z' };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ notes: [memo] }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { serverApiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture-key' };
  await assert.rejects(fetchTrashMemos(config), /invalid note fields/);
});

test('REQ-045 local HTTP redirects cannot forward authenticated requests', async (t) => {
  let targetRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/target') {
      targetRequests++;
      response.end(JSON.stringify({ status: 'ok', version: 1 }));
      return;
    }
    response.writeHead(307, { Location: '/target' }).end();
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { serverApiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test' };
  await assert.rejects(probeServerConnection(config));
  await assert.rejects(sendMemoOperation(config, { operation: 'create', memoId: 'note', operationId: 'op' }));
  assert.equal(targetRequests, 0);
});

test('REQ-041 mock file upload validates checksum metadata, reference and old Server retry', async (t) => {
  const attachment = { id: 'file-memo:file', name: '账单.pdf', media_type: 'application/pdf', size: 5, sha256: 'a'.repeat(64) };
  let uploaded = false;
  let mode = 'valid';
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.method === 'PUT') {
      if (mode === 'old') { response.writeHead(404).end('{}'); return; }
      assert.equal(request.headers.authorization, 'Bearer file-key');
      assert.equal(decodeURIComponent(request.headers['x-file-name']), attachment.name);
      assert.equal(request.headers['x-file-sha256'], attachment.sha256);
      assert.equal(Buffer.concat(chunks).toString(), '%PDF-');
      uploaded = true;
      response.writeHead(201).end(JSON.stringify({ ...attachment, size: mode === 'bad' ? 6 : 5 }));
    } else {
      assert.ok(uploaded);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)).files, [attachment.id]);
      response.writeHead(201).end(JSON.stringify({ version: 1, files: [attachment.id], images: [] }));
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const config = { serverApiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'file-key' };
  const bytes = new TextEncoder().encode('%PDF-').buffer;
  await uploadMemoFile(config, attachment, bytes);
  assert.equal(await sendMemoOperation(config, { operationId: 'op', memoId: 'file-memo', operation: 'create', content: '', files: [attachment.id] }), 1);
  mode = 'bad';
  await assert.rejects(uploadMemoFile(config, attachment, bytes), /metadata/);
  mode = 'old';
  await assert.rejects(uploadMemoFile(config, attachment, bytes), { retryable: true, statusCode: 404 });
});

test('image upload sends authenticated binary data before an image note references it', async (t) => {
  const memoId = '018f4b64-8be1-7ee2-b608-9d26c750f57a';
  const imageId = `${memoId}:0`;
  const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  let uploaded = false;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer image-key');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === `/api/v1/objects/${encodeURIComponent(imageId)}`) {
      assert.equal(request.method, 'PUT');
      assert.equal(request.headers['content-type'], 'image/png');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), Buffer.from(imageBytes));
      uploaded = true;
      response.writeHead(201).end(JSON.stringify({ image_id: imageId }));
    } else if (request.url === '/api/v1/notes') {
      assert.equal(uploaded, true);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const note = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(note.content, '');
      assert.deepEqual(note.images, [imageId]);
      response.writeHead(201).end(JSON.stringify({ note_id: memoId, version: 1, images: [imageId] }));
    } else {
      response.writeHead(404).end(JSON.stringify({ error: { code: 'not_found' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const config = { serverApiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'image-key' };
  await uploadMemoImage(config, imageId, 'image/png', imageBytes.buffer);
  assert.equal(await sendMemoOperation(config, {
    operationId: '0199a633-67aa-7e58-97f8-0196e3684b9d', memoId,
    operation: 'create', content: '', images: [imageId], createdAt: '2026-10-02T00:00:00Z',
  }), 1);
});

test('mock Server accepts a configured API Key and confirms an Outbox operation', async (t) => {
  const operationId = '0199a633-67aa-7e58-97f8-0196e3684b9d';
  const memoId = '018f4b64-8be1-7ee2-b608-9d26c750f57a';
  let postCount = 0;
  const applied = new Map();
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== 'Bearer mock-api-key') {
      response.writeHead(401).end(JSON.stringify({ error: { code: 'invalid_api_key' } }));
      return;
    }
    if (request.url === '/api/v1/health') {
      response.writeHead(200).end(JSON.stringify({ status: 'ok' }));
    } else if (request.url === '/api/v1/notes' && request.method === 'POST') {
      postCount += 1;
      assert.equal(request.headers['idempotency-key'], operationId);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(JSON.parse(Buffer.concat(chunks).toString()).note_id, memoId);
      applied.set(operationId, 1);
      response.writeHead(201).end(JSON.stringify({ note_id: memoId, version: 1 }));
    } else if (request.url === `/api/v1/sync/operations/${operationId}`) {
      const version = applied.get(operationId);
      response.writeHead(version ? 200 : 404).end(version
        ? JSON.stringify({ operation_id: operationId, note_id: memoId, operation: 'create', status: 'applied', result_version: version })
        : JSON.stringify({ error: { code: 'operation_not_found' } }));
    } else {
      response.writeHead(404).end(JSON.stringify({ error: { code: 'not_found' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const config = { serverApiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'mock-api-key' };
  await assert.rejects(probeServerConnection({ ...config, apiKey: 'wrong-key' }), { kind: 'authentication' });
  await assert.rejects(
    sendMemoOperation({ ...config, apiKey: 'wrong-key' }, {
      operationId, memoId, operation: 'create', content: 'mock sync', createdAt: '2026-10-02T00:00:00Z',
    }),
    { retryable: false, statusCode: 401 },
  );
  assert.equal(postCount, 0);
  await probeServerConnection(config);

  const row = {
    operationId, memoId, operation: 'create',
    payload: JSON.stringify({ content: 'mock sync', created_at: '2026-10-02T00:00:00Z' }),
    attemptCount: 0,
  };
  let state = 'pending';
  const dependencies = {
    recoverSendingOperations: async () => { if (state === 'sending') state = 'pending'; },
    getPendingOperations: async () => state === 'acked' ? [] : [{ ...row, attemptCount: postCount }],
    markSending: async () => { state = 'sending'; },
    getLastServerVersion: async () => undefined,
    getAppliedOperationVersion: (id) => getAppliedOperationVersion(config, id),
    sendMemoOperation: (operation) => sendMemoOperation(config, operation),
    markAcknowledged: async (_, version) => { assert.equal(version, 1); state = 'acked'; },
    markFailed: async () => { state = 'retryable_failed'; },
    classifyFailure: (error) => ({ retryable: error instanceof MemoSyncError && error.retryable, message: String(error) }),
  };

  assert.notEqual(state, 'acked'); // The memo presents 未同步 before Server confirmation.
  await synchronizeMemoOutbox(dependencies);
  assert.equal(state, 'acked'); // The badge disappears only after acknowledgement.
  assert.equal(postCount, 1);
  await synchronizeMemoOutbox(dependencies);
  assert.equal(postCount, 1);
  assert.equal(await getAppliedOperationVersion(config, operationId), 1);
  assert.equal(await getAppliedOperationVersion(config, operationId, { memoId, operation: 'create' }), 1);
  await assert.rejects(
    getAppliedOperationVersion(config, operationId, { memoId: 'another-memo', operation: 'create' }),
    { retryable: false },
  );
});

test('HTTP failures keep retryable and permanent outcomes distinct', async (t) => {
  let responseStatus = 500;
  const server = createServer((_, response) => {
    response.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { code: `mock_${responseStatus}` } }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const config = { serverApiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'mock-api-key' };
  const operation = {
    operationId: '0199a633-67aa-7e58-97f8-0196e3684b9d',
    memoId: '018f4b64-8be1-7ee2-b608-9d26c750f57a',
    operation: 'create', content: 'failure test', createdAt: '2026-10-02T00:00:00Z',
  };
  for (const [status, retryable] of [[500, true], [429, true], [401, false], [409, false], [400, false]]) {
    responseStatus = status;
    await assert.rejects(sendMemoOperation(config, operation), { statusCode: status, retryable });
  }
});

test('a lost response can be confirmed using the same operation ID', async (t) => {
  const operationId = '0199a633-67aa-7e58-97f8-0196e3684b9d';
  let applied = false;
  let postCount = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      postCount += 1;
      assert.equal(request.headers['idempotency-key'], operationId);
      applied = true;
      request.socket.destroy();
      return;
    }
    response.writeHead(applied ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(applied
      ? JSON.stringify({ operation_id: operationId, status: 'applied', result_version: 1 })
      : JSON.stringify({ error: { code: 'operation_not_found' } }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const config = { serverApiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'mock-api-key' };
  assert.equal(await getAppliedOperationVersion(config, operationId), undefined);
  await assert.rejects(sendMemoOperation(config, {
    operationId,
    memoId: '018f4b64-8be1-7ee2-b608-9d26c750f57a',
    operation: 'create', content: 'response lost', createdAt: '2026-10-02T00:00:00Z',
  }), { retryable: true });
  assert.equal(await getAppliedOperationVersion(config, operationId), 1);
  assert.equal(postCount, 1);
});

test('network loss and timeout leave the operation retryable', async (t) => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const serverApiUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.closeAllConnections());
  t.after(() => server.close());
  const operation = {
    operationId: '0199a633-67aa-7e58-97f8-0196e3684b9d',
    memoId: '018f4b64-8be1-7ee2-b608-9d26c750f57a',
    operation: 'create', content: 'network test', createdAt: '2026-10-02T00:00:00Z',
  };
  await assert.rejects(sendMemoOperation({ serverApiUrl, apiKey: 'mock-api-key' }, operation), {
    retryable: true, message: 'network_error',
  });
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(sendMemoOperation({ serverApiUrl, apiKey: 'mock-api-key' }, operation), {
    retryable: true, message: 'network_error',
  });
});
