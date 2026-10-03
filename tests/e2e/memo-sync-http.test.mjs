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
const { getAppliedOperationVersion, sendMemoOperation, uploadMemoImage, MemoSyncError } = require(join(compiledDirectory, 'memo-sync.js'));

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
