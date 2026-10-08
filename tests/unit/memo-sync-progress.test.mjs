// REQ-051/067: actual native sync exports report queued restores and settle after failure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadSync({ configured = true, beforeAcknowledgement = async () => {} } = {}) {
  const operations = [];
  const database = {
    async runAsync(sql, ...args) {
      if (sql.includes("SET state = 'sending'")) operations.find((row) => row.operation_id === args[0]).state = 'sending';
      if (sql.includes("SET state = 'acked'")) operations.find((row) => row.operation_id === args[1]).state = 'acked';
      return { changes: 1 };
    },
    async getAllAsync() { return operations.filter((row) => row.state === 'pending'); },
    async getFirstAsync(sql, id) {
      if (sql.includes('SELECT memo_id, operation')) return operations.find((row) => row.operation_id === id);
      throw new Error(`Unexpected query: ${sql}`);
    },
    async withExclusiveTransactionAsync(callback) { return callback(database); },
  };
  const modules = {
    '@/api/memo-sync': {}, 'expo-file-system': {}, '@/storage/objects.native': {}, '@/storage/file-objects.native': {},
    '@/storage/database.native': { getDatabase: async () => database },
    '@/storage/server-connection': { getServerConnectionConfig: async () => configured ? { apiKey: 'fixture', serverApiUrl: 'https://example.invalid' } : undefined },
    '@/sync/memo-pull.native': { pullRemoteMemos: async () => {} },
    '@/sync/memo-outbox-core': { synchronizeMemoOutbox: async (dependencies) => {
      await dependencies.recoverSendingOperations();
      for (const row of await dependencies.getPendingOperations()) {
        await dependencies.markSending(row.operationId);
        await beforeAcknowledgement(row);
        await dependencies.markAcknowledged(row.operationId, 2);
      }
    } },
  };
  const source = readFileSync(new URL('../../src/sync/memo-outbox.native.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(require, exports) { ${compiled}\n})`)((name) => {
    if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  }, exports);
  function queueRestore(id) {
    operations.push({ operation_id: id, memo_id: id, operation: 'restore', payload: '{}', attempt_count: 0, state: 'pending' });
  }
  return { exports, operations, queueRestore };
}

test('REQ-051 native progress counts real operations, decrements on acknowledgement and resets', async () => {
  const { exports, queueRestore } = loadSync();
  queueRestore('first'); queueRestore('second');
  const snapshots = [];
  const unsubscribe = exports.subscribeMemoSyncProgress(() => snapshots.push({ ...exports.getMemoSyncProgress() }));
  await exports.syncMemoOutbox();
  assert.deepEqual(snapshots.map((snapshot) => [snapshot.syncing, snapshot.remainingOperations]), [
    [true, 0], [true, 2], [true, 1], [true, 0], [false, 0],
  ]);
  unsubscribe();
  await exports.syncMemoOutbox();
  assert.equal(snapshots.length, 5);
});

test('REQ-067 restore queued during an active batch gets another batch without concurrent sync', async () => {
  let releaseFirst;
  const waiting = new Promise((resolve) => { releaseFirst = resolve; });
  const { exports, queueRestore, operations } = loadSync({ beforeAcknowledgement: (row) => row.operationId === 'first' ? waiting : Promise.resolve() });
  queueRestore('first');
  const first = exports.syncMemoOutbox();
  await new Promise(setImmediate);
  queueRestore('second');
  const second = exports.syncMemoOutbox();
  assert.equal(first, second);
  releaseFirst();
  await second;
  assert.deepEqual(operations.map((row) => row.state), ['acked', 'acked']);
  assert.equal(exports.getMemoSyncProgress().syncing, false);
});

test('REQ-051 failures reset the title and leave an operation unacknowledged', async () => {
  const { exports, queueRestore, operations } = loadSync({ beforeAcknowledgement: async () => { throw new Error('fixture failure'); } });
  queueRestore('first');
  await assert.rejects(exports.syncMemoOutbox(), /fixture failure/);
  assert.equal(exports.getMemoSyncProgress().syncing, false);
  assert.notEqual(operations[0].state, 'acked');
});

test('REQ-051 an unconfigured server never publishes a syncing title', async () => {
  const { exports } = loadSync({ configured: false });
  const snapshots = [];
  exports.subscribeMemoSyncProgress(() => snapshots.push(exports.getMemoSyncProgress().syncing));
  await exports.syncMemoOutbox();
  assert.ok(snapshots.every((syncing) => !syncing));
});
