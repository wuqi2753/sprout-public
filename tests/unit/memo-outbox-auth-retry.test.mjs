import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadOutbox(database, config) {
  const source = readFileSync(new URL('../../src/sync/memo-outbox.native.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const modules = {
    '@/storage/file-objects.native': {},
    '@/api/memo-sync': {},
    'expo-file-system': {},
    '@/storage/database.native': { getDatabase: async () => database },
    '@/storage/objects.native': {},
    '@/storage/server-connection': { getServerConnectionConfig: async () => config },
    '@/sync/memo-pull.native': { pullRemoteMemos: async () => {} },
    '@/sync/memo-outbox-core': {
      synchronizeMemoOutbox: async (dependencies) => {
        await dependencies.recoverSendingOperations();
        return dependencies.getPendingOperations();
      },
    },
  };
  const wrapped = vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`);
  wrapped((specifier) => {
    if (!(specifier in modules)) throw new Error(`Unexpected module: ${specifier}`);
    return modules[specifier];
  }, { exports }, exports);
  return exports;
}

test('manual sync requeues only authentication failures and preserves operation IDs', async () => {
  const operations = [
    { operation_id: 'auth-1', memo_id: 'memo-1', operation: 'create', payload: '{}', attempt_count: 1, state: 'permanent_failed', last_error: 'invalid_api_key' },
    { operation_id: 'auth-2', memo_id: 'memo-2', operation: 'create', payload: '{}', attempt_count: 1, state: 'permanent_failed', last_error: 'http_401' },
    { operation_id: 'conflict', memo_id: 'memo-3', operation: 'create', payload: '{}', attempt_count: 1, state: 'permanent_failed', last_error: 'version_conflict' },
    { operation_id: 'bad-request', memo_id: 'memo-4', operation: 'create', payload: '{}', attempt_count: 1, state: 'permanent_failed', last_error: 'invalid_content' },
  ];
  const database = {
    async runAsync(sql) {
      if (sql.includes("last_error IN ('invalid_api_key', 'http_401')")) {
        for (const operation of operations) {
          if (operation.state === 'permanent_failed' && ['invalid_api_key', 'http_401'].includes(operation.last_error)) {
            operation.state = 'pending';
            operation.last_error = null;
          }
        }
        return;
      }
      if (sql.includes("state = 'pending' WHERE state = 'sending'")) return;
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async getAllAsync() {
      return operations.filter((operation) => operation.state === 'pending');
    },
  };
  const outbox = loadOutbox(database, { serverApiUrl: 'http://127.0.0.1:18081', apiKey: 'test-key' });

  await outbox.syncMemoOutbox();

  assert.deepEqual(operations.map(({ operation_id, state }) => [operation_id, state]), [
    ['auth-1', 'pending'], ['auth-2', 'pending'],
    ['conflict', 'permanent_failed'], ['bad-request', 'permanent_failed'],
  ]);
});
