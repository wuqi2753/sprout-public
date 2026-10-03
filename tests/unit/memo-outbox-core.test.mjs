import assert from 'node:assert/strict';
import test from 'node:test';

import { synchronizeMemoOutbox } from '../../.tmp/test-build/memo-outbox-core.js';

test('image-only Outbox operation preserves ordered image IDs and local object keys', async () => {
  const sent = [];
  await synchronizeMemoOutbox({
    recoverSendingOperations: async () => {},
    getPendingOperations: async () => [{
      operationId: 'op-image', memoId: 'memo-image', operation: 'create', attemptCount: 0,
      payload: JSON.stringify({ content: '', created_at: '2026-10-03T00:00:00Z',
        images: ['memo-image:1', 'memo-image:0'],
        image_objects: [{ id: 'memo-image:1', object_key: 'memo-image/b.png' }, { id: 'memo-image:0', object_key: 'memo-image/a.png' }],
      }),
    }],
    markSending: async () => {}, getLastServerVersion: async () => undefined,
    getAppliedOperationVersion: async () => undefined,
    sendMemoOperation: async (operation) => { sent.push(operation); return 1; },
    markAcknowledged: async () => {}, markFailed: async () => { throw new Error('unexpected failure'); },
    classifyFailure: (error) => { throw error; },
  });
  assert.deepEqual(sent[0].images, ['memo-image:1', 'memo-image:0']);
  assert.equal(sent[0].imageObjects[0].object_key, 'memo-image/b.png');
  assert.equal(sent[0].content, '');
});

test('failed image upload keeps the same Outbox operation for the next pull', async () => {
  const row = {
    operationId: 'op-image-retry', memoId: 'memo-image', operation: 'create', attemptCount: 0,
    payload: JSON.stringify({ content: '', images: ['memo-image:0'], created_at: '2026-10-03T00:00:00Z' }),
  };
  let state = 'pending';
  let attempts = 0;
  let acknowledgements = 0;
  const dependencies = {
    recoverSendingOperations: async () => {},
    getPendingOperations: async () => state === 'acked' ? [] : [{ ...row, attemptCount: attempts }],
    markSending: async () => { state = 'sending'; },
    getLastServerVersion: async () => undefined,
    getAppliedOperationVersion: async (operationId) => {
      assert.equal(operationId, row.operationId);
      return undefined;
    },
    sendMemoOperation: async (operation) => {
      assert.equal(operation.operationId, row.operationId);
      assert.deepEqual(operation.images, ['memo-image:0']);
      attempts += 1;
      if (attempts === 1) throw new Error('upload failed');
      return 1;
    },
    markAcknowledged: async () => { state = 'acked'; acknowledgements += 1; },
    markFailed: async () => { state = 'retryable_failed'; },
    classifyFailure: (error) => ({ retryable: true, message: String(error) }),
  };
  await synchronizeMemoOutbox(dependencies);
  assert.equal(state, 'retryable_failed');
  assert.equal(acknowledgements, 0);
  await synchronizeMemoOutbox(dependencies);
  assert.equal(state, 'acked');
  assert.equal(attempts, 2);
  assert.equal(acknowledgements, 1);
});

function operation(overrides = {}) {
  return {
    operationId: 'operation-1',
    memoId: 'memo-1',
    operation: 'create',
    payload: JSON.stringify({ content: 'hello', created_at: '2026-10-02T00:00:00.000Z' }),
    attemptCount: 0,
    ...overrides,
  };
}

function createDependencies(rows) {
  const events = [];
  const sent = [];
  const acknowledged = [];
  const failed = [];
  const dependencies = {
    recoverSendingOperations: async () => { events.push('recover'); },
    getPendingOperations: async () => rows,
    markSending: async (operationId) => { events.push(`sending:${operationId}`); },
    getLastServerVersion: async () => 4,
    getAppliedOperationVersion: async (operationId) => {
      events.push(`status:${operationId}`);
      return undefined;
    },
    sendMemoOperation: async (request) => {
      sent.push(request);
      events.push(`send:${request.operationId}`);
      return 5;
    },
    markAcknowledged: async (operationId, version) => {
      acknowledged.push([operationId, version]);
      events.push(`acked:${operationId}`);
    },
    markFailed: async (row, failure) => { failed.push([row, failure]); },
    classifyFailure: (error) => ({ retryable: true, message: String(error) }),
  };
  return { dependencies, events, sent, acknowledged, failed };
}

test('recovers sending operations and does not resend acknowledged operations', async () => {
  const context = createDependencies([]);
  await synchronizeMemoOutbox(context.dependencies);
  assert.deepEqual(context.events, ['recover']);
  assert.deepEqual(context.sent, []);
});

test('queries a retried operation with the same operation ID before resending it', async () => {
  const row = operation({ operationId: 'stable-operation', attemptCount: 2 });
  const context = createDependencies([row]);
  context.dependencies.getAppliedOperationVersion = async (operationId) => {
    context.events.push(`status:${operationId}`);
    return 3;
  };

  await synchronizeMemoOutbox(context.dependencies);

  assert.deepEqual(context.sent, []);
  assert.deepEqual(context.acknowledged, [['stable-operation', 3]]);
  assert.deepEqual(context.events, ['recover', 'sending:stable-operation', 'status:stable-operation', 'acked:stable-operation']);
});

test('queries a recovered sending operation before deciding whether to resend', async () => {
  const row = operation({ operationId: 'interrupted-operation', attemptCount: 1 });
  const context = createDependencies([row]);
  context.dependencies.getAppliedOperationVersion = async (operationId) => {
    context.events.push(`status:${operationId}`);
    return 2;
  };

  await synchronizeMemoOutbox(context.dependencies);

  assert.deepEqual(context.sent, []);
  assert.deepEqual(context.acknowledged, [['interrupted-operation', 2]]);
  assert.deepEqual(context.events, [
    'recover', 'sending:interrupted-operation', 'status:interrupted-operation', 'acked:interrupted-operation',
  ]);
});

test('reuses the operation ID when status is missing and sends the stored payload', async () => {
  const row = operation({ operationId: 'stable-operation', attemptCount: 1 });
  const context = createDependencies([row]);
  await synchronizeMemoOutbox(context.dependencies);
  assert.equal(context.sent[0]?.operationId, 'stable-operation');
  assert.equal(context.sent[0]?.content, 'hello');
  assert.equal(context.sent[0]?.createdAt, '2026-10-02T00:00:00.000Z');
});

test('blocks later operations for a failed memo but continues another memo', async () => {
  const rows = [
    operation({ operationId: 'memo-1-first' }),
    operation({ operationId: 'memo-1-second', operation: 'update' }),
    operation({ operationId: 'memo-2-first', memoId: 'memo-2' }),
  ];
  const context = createDependencies(rows);
  context.dependencies.sendMemoOperation = async (request) => {
    context.sent.push(request);
    if (request.operationId === 'memo-1-first') throw new Error('offline');
    return 1;
  };

  await synchronizeMemoOutbox(context.dependencies);

  assert.deepEqual(context.sent.map((request) => request.operationId), ['memo-1-first', 'memo-2-first']);
  assert.equal(context.failed.length, 1);
  assert.deepEqual(context.acknowledged, [['memo-2-first', 1]]);
});

test('passes permanent and retryable failure classification to storage', async () => {
  const context = createDependencies([operation()]);
  context.dependencies.sendMemoOperation = async () => { throw new Error('unauthorized'); };
  context.dependencies.classifyFailure = () => ({ retryable: false, message: 'http_401' });

  await synchronizeMemoOutbox(context.dependencies);

  assert.deepEqual(context.failed[0]?.[1], { retryable: false, message: 'http_401' });
  assert.deepEqual(context.acknowledged, []);
});

test('uses the last acknowledged server version for update and delete operations', async () => {
  const rows = [
    operation({ operationId: 'update-1', operation: 'update', payload: JSON.stringify({ content: 'changed' }) }),
    operation({ operationId: 'delete-1', memoId: 'memo-2', operation: 'delete', payload: '{}' }),
  ];
  const context = createDependencies(rows);
  await synchronizeMemoOutbox(context.dependencies);
  assert.deepEqual(context.sent.map((request) => request.baseVersion), [4, 4]);
});
