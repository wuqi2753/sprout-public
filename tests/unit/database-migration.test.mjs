import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadDatabase(database) {
  const source = readFileSync(new URL('../../src/storage/database.native.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const modules = {
    'expo-sqlite': { openDatabaseAsync: async () => database },
    '@/sync/uuid': { createUuid: () => 'operation-1' },
  };
  const wrapped = vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`);
  wrapped((specifier) => {
    if (!(specifier in modules)) throw new Error(`Unexpected module: ${specifier}`);
    return modules[specifier];
  }, { exports }, exports);
  return exports;
}

test('opening an older memo database adds server_version without changing stored notes', async () => {
  const existingMemo = { id: 'memo-1', content: 'existing note', created_at: '2026-10-02T00:00:00Z', server_version: null };
  const columns = ['id', 'content', 'created_at', 'updated_at'];
  let migrationCount = 0;
  const database = {
    async execAsync(sql) {
      if (sql.includes('ALTER TABLE memos ADD COLUMN server_version INTEGER')) {
        columns.push('server_version');
        migrationCount += 1;
      }
    },
    async getAllAsync(sql) {
      if (sql === 'PRAGMA table_info(memo_files)') return [{ name: 'position' }];
      if (sql === 'PRAGMA table_info(memos)') return columns.map((name) => ({ name }));
      if (sql.includes("FROM sqlite_master")) return [{ sql: "CHECK (operation IN ('restore'))" }];
      if (sql.includes('SELECT id, content, created_at FROM memos')) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async getFirstAsync(sql) {
      if (sql === 'PRAGMA user_version') return { user_version: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async runAsync(sql, serverVersion, memoId) {
      if (!sql.includes('UPDATE memos SET server_version')) throw new Error(`Unexpected SQL: ${sql}`);
      if (!columns.includes('server_version')) throw new Error('no such column: server_version');
      if (memoId === existingMemo.id) existingMemo.server_version = serverVersion;
    },
  };
  const storage = loadDatabase(database);

  assert.equal(await storage.getDatabase(), database);
  assert.equal(await storage.getDatabase(), database);
  assert.equal(migrationCount, 1);
  assert.ok(columns.includes('server_version'));
  await database.runAsync('UPDATE memos SET server_version = ? WHERE id = ?', 1, 'memo-1');
  assert.equal(existingMemo.server_version, 1);
  assert.equal(existingMemo.content, 'existing note');
});

test('migration requeues image-only create and adds image update for text already acknowledged', async () => {
  const writes = [];
  const imageRows = [
    { memo_id: 'image-only', id: 'image-only:0', object_key: 'image-only/one.png' },
    { memo_id: 'mixed', id: 'mixed:0', object_key: 'mixed/one.jpg' },
    { memo_id: 'attempted', id: 'attempted:0', object_key: 'attempted/one.png' },
  ];
  const operations = {
    'image-only': [{ operation_id: 'create-image', operation: 'create', payload: '{"content":"","created_at":"2026-10-03T00:00:00Z"}', state: 'permanent_failed', attempt_count: 1, last_error: 'invalid_content' }],
    mixed: [{ operation_id: 'create-mixed', operation: 'create', payload: '{"content":"text","created_at":"2026-10-03T00:00:00Z"}', state: 'acked', attempt_count: 1, last_error: null }],
    attempted: [{ operation_id: 'create-attempted', operation: 'create', payload: '{"content":"text","created_at":"2026-10-03T00:00:00Z"}', state: 'retryable_failed', attempt_count: 1, last_error: 'network_error' }],
  };
  const transaction = {
    async getAllAsync(sql, memoId) {
      if (sql.includes('FROM memo_images')) return imageRows;
      if (sql.includes('FROM memo_outbox')) return operations[memoId];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async getFirstAsync(sql, memoId) {
      if (sql.includes('FROM memos')) return { content: 'text', updated_at: '2026-10-03T00:00:00Z' };
      throw new Error(`Unexpected SQL: ${sql} ${memoId}`);
    },
    async runAsync(sql, ...args) { writes.push({ sql, args }); },
    async execAsync(sql) { writes.push({ sql, args: [] }); },
  };
  const database = {
    async execAsync() {},
    async getAllAsync(sql) {
      if (sql === 'PRAGMA table_info(memo_files)') return [{ name: 'position' }];
      if (sql === 'PRAGMA table_info(memos)') return [{ name: 'server_version' }];
      if (sql.includes("FROM sqlite_master")) return [{ sql: "CHECK (operation IN ('restore'))" }];
      if (sql.includes('SELECT id, content, created_at FROM memos')) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async getFirstAsync(sql) {
      if (sql === 'PRAGMA user_version') return { user_version: 0 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async withExclusiveTransactionAsync(callback) { await callback(transaction); },
  };
  await loadDatabase(database).getDatabase();
  const requeued = writes.find((write) => write.sql.includes("UPDATE memo_outbox SET payload"));
  assert.deepEqual(JSON.parse(requeued.args[0]).images, ['image-only:0']);
  assert.equal(JSON.parse(requeued.args[0]).image_objects[0].object_key, 'image-only/one.png');
  assert.equal(requeued.args[1], 'create-image');
  const backfill = writes.find((write) => write.sql.includes("VALUES (?, ?, 'update'"));
  assert.equal(backfill.args[1], 'mixed');
  assert.deepEqual(JSON.parse(backfill.args[2]).images, ['mixed:0']);
  assert.equal(writes.filter((write) => write.sql.includes("VALUES (?, ?, 'update'")).length, 2);
  assert.ok(!writes.some((write) => write.sql.includes('UPDATE memo_outbox SET payload') && write.args[1] === 'create-attempted'));
  assert.ok(writes.some((write) => write.sql === 'PRAGMA user_version = 1'));
});
