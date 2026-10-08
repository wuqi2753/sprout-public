import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { recordingStartModules } from '../fixtures/recording-start.mjs';

function loadMemoStorage(database, deletedObjects) {
  const source = readFileSync(new URL('../../src/storage/memos.native.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const modules = {
    ...recordingStartModules(),
    '@/storage/database.native': { getDatabase: async () => database },
    '@/storage/objects.native': {
      persistMemoImages: async () => [],
      deleteMemoObjects: (id) => deletedObjects.push(id),
      resolveObjectUri: (key) => key,
    },
    '@/memos': { extractTags: () => [] },
    '@/sync/uuid': { createUuid: () => 'operation-1' },
  };
  const wrapped = vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`);
  wrapped((specifier) => {
    if (specifier === '@/storage/file-objects.native') return { persistMemoFile: async () => { throw new Error("Unexpected file persistence"); } };
    if (specifier === '@/storage/file-attachment-rules') return {};
    if (!(specifier in modules)) throw new Error(`Unexpected module: ${specifier}`);
    return modules[specifier];
  }, { exports }, exports);
  return exports;
}

function createTransactionalDatabase(failOutboxInsert = false, initialMemos = [], initialImages = []) {
  const state = { memos: structuredClone(initialMemos), images: structuredClone(initialImages), outbox: [] };
  return {
    state,
    async getAllAsync(sql) {
      if (sql.includes('FROM memos')) return state.memos.map((memo) => ({
        ...memo, created_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z', hidden: memo.hidden ?? 0, synced: 0,
      }));
      if (sql.includes('FROM memo_images')) return state.images.map((image) => ({ memo_id: image.memoId, object_key: image.objectKey }));
      if (sql.includes('FROM memo_files')) return [];
      throw new Error(`Unexpected read SQL: ${sql}`);
    },
    async withExclusiveTransactionAsync(callback) {
      const snapshot = structuredClone(state);
      const transaction = {
        async getFirstAsync(_sql, id) {
          const memo = state.memos.find((entry) => entry.id === id && !entry.deleted_at && !entry.purged_at);
          return memo ? { hidden: memo.hidden ?? 0 } : null;
        },
        async runAsync(sql, ...parameters) {
          if (sql.includes('INSERT INTO memos')) {
            state.memos.push({ id: parameters[0], content: parameters[1] });
          } else if (sql.startsWith('UPDATE memos SET deleted_at')) {
            const memo = state.memos.find((entry) => entry.id === parameters[2] && !entry.deleted_at && !entry.purged_at);
            if (!memo) return { changes: 0 };
            memo.deleted_at = parameters[0];
            memo.purged_at = parameters[1];
          } else if (sql.startsWith('UPDATE memos')) {
            const memo = state.memos.find((entry) => entry.id === parameters[2]);
            if (!memo) return { changes: 0 };
            memo.content = parameters[0];
          } else if (sql.startsWith('DELETE FROM memos')) {
            const index = state.memos.findIndex((entry) => entry.id === parameters[0]);
            if (index < 0) return { changes: 0 };
            state.memos.splice(index, 1);
          } else if (sql.startsWith('DELETE FROM memo_files')) {
            return { changes: 0 };
          } else if (sql.startsWith('DELETE FROM memo_images')) {
            state.images = state.images.filter((entry) => entry.memoId !== parameters[0]);
          } else if (sql.includes('INSERT INTO memo_outbox')) {
            if (failOutboxInsert) throw new Error('simulated outbox write failure');
            state.outbox.push({ operationId: parameters[0], memoId: parameters[1] });
          } else {
            throw new Error(`Unexpected SQL: ${sql}`);
          }
          return { changes: 1 };
        },
      };
      try {
        return await callback(transaction);
      } catch (error) {
        state.memos = snapshot.memos;
        state.images = snapshot.images;
        state.outbox = snapshot.outbox;
        throw error;
      }
    },
  };
}

const memoInput = {
  id: 'memo-1', content: 'hello', imageUris: [], createdOn: new Date('2026-10-02T00:00:00.000Z'),
};

test('saving a memo commits its local row and Outbox operation together', async () => {
  const database = createTransactionalDatabase();
  const storage = loadMemoStorage(database, []);
  await storage.addMemo(memoInput);
  assert.deepEqual(database.state.memos, [{ id: 'memo-1', content: 'hello' }]);
  assert.deepEqual(database.state.outbox, [{ operationId: 'operation-1', memoId: 'memo-1' }]);
});

test('an Outbox write failure rolls back the local memo row', async () => {
  const database = createTransactionalDatabase(true);
  const deletedObjects = [];
  const storage = loadMemoStorage(database, deletedObjects);
  await assert.rejects(storage.addMemo(memoInput), /Failed to save memo memo-1/);
  assert.deepEqual(database.state.memos, []);
  assert.deepEqual(database.state.outbox, []);
  assert.deepEqual(deletedObjects, ['memo-1']);
});

test('an Outbox write failure rolls back a memo update', async () => {
  const database = createTransactionalDatabase(true, [{ id: 'memo-1', content: 'original' }]);
  const storage = loadMemoStorage(database, []);
  await assert.rejects(storage.updateMemoContent('memo-1', 'changed', new Date()), /simulated outbox write failure/);
  assert.deepEqual(database.state.memos, [{ id: 'memo-1', content: 'original' }]);
  assert.deepEqual(database.state.outbox, []);
});

test('an Outbox write failure rolls back a memo deletion', async () => {
  const database = createTransactionalDatabase(true, [{ id: 'memo-1', content: 'original' }], [{ memoId: 'memo-1' }]);
  const deletedObjects = [];
  const storage = loadMemoStorage(database, deletedObjects);
  await assert.rejects(storage.deleteMemo('memo-1'), /simulated outbox write failure/);
  assert.deepEqual(database.state.memos, [{ id: 'memo-1', content: 'original' }]);
  assert.deepEqual(database.state.images, [{ memoId: 'memo-1' }]);
  assert.deepEqual(database.state.outbox, []);
  assert.deepEqual(deletedObjects, []);
});

test('deleting a memo keeps its image relations available for recovery', async () => {
  const database = createTransactionalDatabase(false, [{ id: 'memo-1', content: '' }], [{ memoId: 'memo-1' }]);
  const storage = loadMemoStorage(database, []);
  await storage.deleteMemo('memo-1');
  assert.equal(database.state.memos.length, 1);
  assert.ok(database.state.memos[0].deleted_at);
  assert.deepEqual(database.state.images, [{ memoId: 'memo-1' }]);
  assert.deepEqual(database.state.outbox, [{ operationId: 'operation-1', memoId: 'memo-1' }]);
});
