// REQ-037: Execute the native initializer against isolated, real SQLite databases.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Python's standard library supplies SQLite without adding an app dependency.
// REQ-039: Welcome initialization uses the same real SQLite harness.
const sqliteBridge = `
import json, sqlite3, sys
connection = sqlite3.connect(sys.argv[1], isolation_level=None)
connection.row_factory = sqlite3.Row
for line in sys.stdin:
    request = json.loads(line)
    try:
        operation = request['operation']
        if operation == 'close':
            connection.close()
            result = None
        elif operation == 'exec':
            statement = ''
            for character in request['sql']:
                statement += character
                if character == ';' and sqlite3.complete_statement(statement):
                    connection.execute(statement)
                    statement = ''
            if statement.strip():
                connection.execute(statement)
            result = None
        else:
            cursor = connection.execute(request['sql'], request.get('parameters', []))
            result = [dict(row) for row in cursor.fetchall()] if operation == 'query' else {'changes': cursor.rowcount, 'lastInsertRowId': cursor.lastrowid}
        print(json.dumps({'id': request['id'], 'result': result}), flush=True)
        if operation == 'close':
            break
    except Exception as error:
        print(json.dumps({'id': request['id'], 'error': str(error)}), flush=True)
`;

function openSQLite(databasePath) {
  const child = spawn('python3', ['-u', '-c', sqliteBridge, databasePath]);
  const requests = new Map();
  let sequence = 0;
  let closed = false;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => {
    for (const request of requests.values()) request.reject(error);
    requests.clear();
  });
  child.on('exit', (code) => {
    for (const request of requests.values()) request.reject(new Error(`SQLite test bridge exited (${code}): ${stderr}`));
    requests.clear();
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line);
    const request = requests.get(response.id);
    requests.delete(response.id);
    if (response.error) request.reject(new Error(response.error));
    else request.resolve(response.result);
  });
  function execute(operation, sql = '', parameters = []) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      requests.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, operation, sql, parameters }) + '\n');
    });
  }
  return {
    execAsync: (sql) => execute('exec', sql),
    getAllAsync: (sql, ...parameters) => execute('query', sql, parameters),
    async getFirstAsync(sql, ...parameters) { return (await execute('query', sql, parameters))[0] ?? null; },
    runAsync: (sql, ...parameters) => execute('run', sql, parameters),
    async withExclusiveTransactionAsync(callback) {
      await execute('exec', 'BEGIN EXCLUSIVE;');
      try {
        await callback(this);
        await execute('exec', 'COMMIT;');
      } catch (error) {
        await execute('exec', 'ROLLBACK;');
        throw error;
      }
    },
    async closeAsync() {
      if (closed) return;
      closed = true;
      const exited = once(child, 'exit');
      await execute('close');
      child.stdin.end();
      await exited;
    },
  };
}

function loadStorage(filename, modules) {
  const source = readFileSync(new URL(`../../src/storage/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`)((specifier) => {
    if (!(specifier in modules)) throw new Error(`Unexpected module: ${specifier}`);
    return modules[specifier];
  }, { exports }, exports);
  return exports;
}

function nativeStorage(open) {
  let sequence = 0;
  return loadStorage('database.native.ts', {
    'expo-sqlite': { openDatabaseAsync: open },
    '@/sync/uuid': { createUuid: () => `migration-operation-${++sequence}` },
  });
}

function isolatedDirectory(context) {
  const temporary = new URL('../../.tmp/', import.meta.url);
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(path.join(temporary.pathname, 'app-initialization-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('REQ-037 fresh initialization creates empty tables and does not seed credentials or images', async (context) => {
  const directory = isolatedDirectory(context);
  const databasePath = path.join(directory, 'sprout.db');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const database = openSQLite(databasePath);
    try {
      const storage = nativeStorage(async (name) => { assert.equal(name, 'sprout.db'); return database; });
      assert.equal(await storage.getDatabase(), database);
      for (const table of ['memos', 'memo_images', 'memo_outbox']) {
        assert.equal((await database.getFirstAsync(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0);
      }
      assert.equal((await database.getFirstAsync('PRAGMA foreign_keys')).foreign_keys, 1);
      assert.equal((await database.getFirstAsync('PRAGMA user_version')).user_version, 1);
      const indexes = await database.getAllAsync("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('memo_images_memo_id_index','memo_outbox_pending_index','memo_outbox_memo_id_index')");
      assert.equal(indexes.length, 3);
      await assert.rejects(database.runAsync("INSERT INTO memo_images VALUES ('missing:0', 'missing', 'missing/image.png', 0)"), /FOREIGN KEY/);
      await assert.rejects(database.runAsync("INSERT INTO memo_outbox (operation_id,memo_id,operation,payload,state,created_at) VALUES ('invalid','missing','unsupported','{}','pending','2026-10-03')"), /CHECK constraint/);
    } finally { await database.closeAsync(); }
  }
  const connection = loadStorage('server-connection.native.ts', {
    'expo-secure-store': { getItemAsync: async () => null },
  });
  assert.equal(await connection.getServerConnectionConfig(), undefined);
  assert.equal(existsSync(path.join(directory, 'objects')), false);
});

test('REQ-037 legacy notes and image migrations survive reopening without duplicate operations', async (context) => {
  const directory = isolatedDirectory(context);
  const databasePath = path.join(directory, 'sprout.db');
  const original = openSQLite(databasePath);
  await original.execAsync(`
    CREATE TABLE memos (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE memo_images (id TEXT PRIMARY KEY, memo_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, position INTEGER NOT NULL);
    INSERT INTO memos VALUES ('memo-1', 'Retained note', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z');
    INSERT INTO memo_images VALUES ('memo-1:0', 'memo-1', 'memo-1/image.png', 0);
  `);
  await original.closeAsync();
  mkdirSync(path.join(directory, 'objects'));
  const imagePath = path.join(directory, 'objects/image.png');
  writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
  let operations;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const database = openSQLite(databasePath);
    try {
      await nativeStorage(async () => database).getDatabase();
      assert.equal((await database.getFirstAsync('SELECT content FROM memos')).content, 'Retained note');
      assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM memo_images')).count, 1);
      const current = await database.getAllAsync('SELECT * FROM memo_outbox');
      assert.equal(current.length, 1);
      assert.deepEqual(JSON.parse(current[0].payload).images, ['memo-1:0']);
      if (operations) assert.deepEqual(current, operations);
      operations = current;
    } finally { await database.closeAsync(); }
  }
  assert.deepEqual(readFileSync(imagePath), Buffer.from([137, 80, 78, 71]));
});

test('REQ-037 failed initialization closes the connection and can retry after repair', async (context) => {
  const directory = isolatedDirectory(context);
  const databasePath = path.join(directory, 'sprout.db');
  let database = openSQLite(databasePath);
  await database.execAsync('CREATE TABLE memos (unexpected TEXT);');
  let opens = 0;
  const storage = nativeStorage(async () => { opens += 1; return database; });
  await assert.rejects(storage.getDatabase(), /Failed to initialize App SQLite database/);
  // Repair only this isolated test fixture after the failed connection was closed.
  database = openSQLite(databasePath);
  await database.execAsync('DROP TABLE memos;');
  try {
    await storage.getDatabase();
    assert.equal(opens, 2);
    assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM memos')).count, 0);
  } finally { await database.closeAsync(); }
});

test('REQ-037 records and acknowledged sync state survive reopening a newly created database', async (context) => {
  const directory = isolatedDirectory(context);
  const databasePath = path.join(directory, 'sprout.db');
  let database = openSQLite(databasePath);
  const storage = nativeStorage(async () => database);
  const memos = loadStorage('memos.native.ts', {
    '@/storage/database.native': storage,
    '@/storage/objects.native': {
      persistMemoImages: async () => ['new-memo/image.png'],
      resolveObjectUri: (key) => path.join(directory, 'objects', key),
      deleteMemoObjects: () => { throw new Error('Initialization must not delete images'); },
    },
    '@/memos': { extractTags: () => [] },
    '@/sync/uuid': { createUuid: () => 'new-operation' },
  });
  try {
    await memos.addMemo({ id: 'new-memo', content: 'Saved after initialization', imageUris: ['selected.png'], createdOn: new Date('2026-10-03T00:00:00Z') });
    await database.runAsync("UPDATE memo_outbox SET state='acked', result_version=1");
    await database.runAsync('UPDATE memos SET server_version=1');
  } finally { await database.closeAsync(); }
  database = openSQLite(databasePath);
  try {
    await nativeStorage(async () => database).getDatabase();
    assert.equal((await database.getFirstAsync('SELECT content FROM memos')).content, 'Saved after initialization');
    assert.equal((await database.getFirstAsync('SELECT server_version FROM memos')).server_version, 1);
    assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM memo_images')).count, 1);
    assert.equal((await database.getFirstAsync('SELECT state FROM memo_outbox')).state, 'acked');
    assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM memo_outbox')).count, 1);
  } finally { await database.closeAsync(); }
});

test('REQ-039 welcome memo is atomic, retryable and never recreated after deletion or reopening', async (context) => {
  const directory = isolatedDirectory(context);
  const databasePath = path.join(directory, 'sprout.db');
  let database = openSQLite(databasePath);
  let sequence = 0;
  const loadMemos = () => loadStorage('memos.native.ts', {
    '@/storage/database.native': nativeStorage(async () => database),
    '@/storage/objects.native': {},
    '@/memos': {},
    '@/sync/uuid': { createUuid: () => `welcome-${++sequence}` },
  });
  try {
    const memos = loadMemos();
    await nativeStorage(async () => database).getDatabase();
    await database.execAsync("CREATE TRIGGER reject_welcome BEFORE INSERT ON memo_outbox BEGIN SELECT RAISE(ABORT, 'outbox failure'); END;");
    await assert.rejects(memos.initializeWelcomeMemo(), /outbox failure/);
    for (const table of ['memos', 'memo_outbox', 'app_initialization']) {
      assert.equal((await database.getFirstAsync(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0);
    }
    await database.execAsync('DROP TRIGGER reject_welcome;');
    const startedAt = Date.now();
    await memos.initializeWelcomeMemo();
    await memos.initializeWelcomeMemo();
    const memo = await database.getFirstAsync('SELECT * FROM memos');
    assert.equal(memo.content, '#开心 欢迎来到 Sprout!');
    assert.ok(Date.parse(memo.created_at) >= startedAt && Date.parse(memo.created_at) <= Date.now());
    const operation = await database.getFirstAsync('SELECT * FROM memo_outbox');
    assert.equal(operation.memo_id, memo.id);
    assert.equal(operation.state, 'pending');
    assert.equal(JSON.parse(operation.payload).content, memo.content);
    assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM memos')).count, 1);
    await database.runAsync('DELETE FROM memos');
  } finally { await database.closeAsync(); }
  database = openSQLite(databasePath);
  try {
    await loadMemos().initializeWelcomeMemo();
    assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM memos')).count, 0);
    await database.runAsync('DELETE FROM app_initialization');
    await database.runAsync("INSERT INTO memos (id, content, created_at, updated_at) VALUES ('existing', 'personal note', '2026-10-03', '2026-10-03')");
    await loadMemos().initializeWelcomeMemo();
    assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM memos')).count, 1);
    assert.equal((await database.getFirstAsync('SELECT content FROM memos')).content, 'personal note');
    assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM app_initialization')).count, 1);
  } finally { await database.closeAsync(); }
});

test('REQ-037 an existing connection config is read without resetting credentials', async () => {
  const saved = new Map([['sprout.server-api-url', 'http://127.0.0.1:8080'], ['sprout.server-api-key', 'test-key']]);
  const connection = loadStorage('server-connection.native.ts', {
    'expo-secure-store': { getItemAsync: async (key) => saved.get(key) ?? null },
  });
  const configuration = await connection.getServerConnectionConfig();
  assert.equal(configuration.serverApiUrl, 'http://127.0.0.1:8080');
  assert.equal(configuration.apiKey, 'test-key');
  assert.equal(saved.size, 2);
});
