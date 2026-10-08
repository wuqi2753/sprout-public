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
import { recordingStartModules } from '../fixtures/recording-start.mjs';

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
  modules = { ...recordingStartModules(), ...modules };
  const source = readFileSync(new URL(`../../src/storage/${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`)((specifier) => {
    if (!(specifier in modules) && specifier === '@/storage/file-objects.native') return { persistMemoFile: async () => { throw new Error("Unexpected file persistence"); } };
    if (!(specifier in modules) && specifier === '@/storage/file-attachment-rules') return {};
    if (!(specifier in modules)) throw new Error(`Unexpected module: ${specifier}`);
    return modules[specifier];
  }, { exports }, exports);
  return exports;
}

// REQ-041: File-only rows and immutable Outbox snapshots in real SQLite.
test('REQ-041 file records survive reopen and failed Outbox insertion rolls back', async (context) => {
  const directory = isolatedDirectory(context);
  const databasePath = path.join(directory, 'files.db');
  let database = openSQLite(databasePath);
  let sequence = 0;
  const stored = { id: 'file-memo:file', objectKey: 'file-memo/object.pdf', uri: 'file://private/object.pdf', name: '账单.pdf', mediaType: 'application/pdf', size: 5, sha256: 'a'.repeat(64) };
  const removed = [];
  const loadMemos = () => loadStorage('memos.native.ts', {
    '@/storage/database.native': nativeStorage(async () => database),
    '@/storage/objects.native': { persistMemoImages: async () => [], resolveObjectUri: (key) => key, deleteMemoObjects: (id) => removed.push(id) },
    '@/storage/file-objects.native': { persistMemoFile: async () => stored },
    '@/storage/file-attachment-rules': { validateFileAttachment: (name, size) => ({ name, size, mediaType: 'application/pdf' }) },
    '@/memos': { extractTags: () => [] },
    '@/sync/uuid': { createUuid: () => `operation-${++sequence}` },
  });
  try {
    await loadMemos().addMemo({ id: 'file-memo', content: '', createdOn: new Date(), imageUris: [], fileAttachments: [stored] });
    assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM memo_files')).count, 1);
    const payload = JSON.parse((await database.getFirstAsync('SELECT payload FROM memo_outbox')).payload);
    assert.deepEqual(payload.files, ['file-memo:file']);
    assert.equal(payload.file_objects[0].sha256, stored.sha256);
  } finally { await database.closeAsync(); }
  database = openSQLite(databasePath);
  try {
    const memos = loadMemos();
    assert.equal((await memos.getMemos())[0].fileAttachments[0].name, '账单.pdf');
    await database.execAsync("CREATE TRIGGER reject_outbox BEFORE INSERT ON memo_outbox BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    await assert.rejects(memos.addMemo({ id: 'failed-memo', content: '', createdOn: new Date(), imageUris: [], fileAttachments: [stored] }), /Failed to save/);
    assert.deepEqual(removed, ['failed-memo']);
    assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM memos')).count, 1);
    await database.execAsync('DROP TRIGGER reject_outbox');
    await memos.deleteMemo('file-memo');
    assert.equal((await database.getFirstAsync('SELECT COUNT(*) AS count FROM memo_files')).count, 1);
    assert.equal((await memos.getTrashMemos())[0].fileAttachments[0].name, '账单.pdf');
    assert.deepEqual(removed, ['failed-memo'], 'trash retains its file until permanent deletion is acknowledged');
  } finally { await database.closeAsync(); }
});

// REQ-043: Real SQLite migration, restart, failure and Outbox isolation.
test('REQ-043 hidden state survives migration and reopen without changing memo or Outbox', async (context) => {
  const directory = isolatedDirectory(context);
  const databasePath = path.join(directory, 'visibility.db');
  let database = openSQLite(databasePath);
  const loadMemos = () => loadStorage('memos.native.ts', {
    '@/storage/database.native': nativeStorage(async () => database),
    '@/storage/objects.native': { resolveObjectUri: (key) => key },
    '@/memos': { extractTags: () => [] },
    '@/sync/uuid': { createUuid: () => 'visibility-operation' },
  });
  let original;
  let outbox;
  try {
    await database.execAsync("CREATE TABLE memos (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO memos VALUES ('old', 'retained', '2026-10-01', '2026-10-02');");
    const storage = loadMemos();
    assert.equal((await storage.getMemos())[0].hidden, false);
    original = await database.getFirstAsync('SELECT * FROM memos');
    outbox = await database.getAllAsync('SELECT * FROM memo_outbox');
    await storage.setMemoHidden('old', true);
    assert.equal((await storage.getMemo('old')).hidden, true);
    await assert.rejects(storage.setMemoHidden('missing', true), /missing memo/);
    await assert.rejects(storage.setMemoHidden('old', 1), /boolean/);
  } finally { await database.closeAsync(); }
  database = openSQLite(databasePath);
  try {
    const storage = loadMemos();
    assert.equal((await storage.getMemo('old')).hidden, true);
    assert.deepEqual(await database.getFirstAsync('SELECT * FROM memos'), { ...original, hidden: 1 });
    assert.deepEqual(await database.getAllAsync('SELECT * FROM memo_outbox'), outbox);
    await database.execAsync("CREATE TRIGGER reject_visibility BEFORE UPDATE OF hidden ON memos BEGIN SELECT RAISE(ABORT, 'visibility write failure'); END;");
    await assert.rejects(storage.setMemoHidden('old', false), /visibility write failure/);
    assert.equal((await storage.getMemo('old')).hidden, true);
    await database.execAsync('DROP TRIGGER reject_visibility;');
    await storage.setMemoHidden('old', false);
    assert.deepEqual(await database.getFirstAsync('SELECT * FROM memos'), original);
    assert.deepEqual(await database.getAllAsync('SELECT * FROM memo_outbox'), outbox);
  } finally { await database.closeAsync(); }
});

function nativeStorage(open) {
  let sequence = 0;
  return loadStorage('database.native.ts', {
    'expo-sqlite': { openDatabaseAsync: open },
    '@/sync/uuid': { createUuid: () => `migration-operation-${++sequence}` },
  });
}

// REQ-052: real SQLite validates relation migration, ordering, restart and queue retention.
test('REQ-052 legacy file migrates without changing its pending snapshot and permits additional files', async (context) => {
  const directory = isolatedDirectory(context);
  const databasePath = path.join(directory, 'legacy-files.db');
  let database = openSQLite(databasePath);
  await nativeStorage(async () => database).getDatabase();
  const originalPayload = JSON.stringify({ content: 'old', files: ['legacy:file'], file_objects: [{ id: 'legacy:file', object_key: 'legacy/old.pdf' }] });
  await database.execAsync(`DROP TABLE memo_files;
    CREATE TABLE memo_files (id TEXT PRIMARY KEY NOT NULL, memo_id TEXT NOT NULL UNIQUE, object_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE);
    INSERT INTO memos(id,content,created_at,updated_at) VALUES('legacy','old','2026-10-05T00:00:00Z','2026-10-05T00:00:00Z');`);
  await database.runAsync('INSERT INTO memo_files VALUES(?,?,?,?,?,?,?)', 'legacy:file', 'legacy', 'legacy/old.pdf', 'old.pdf', 'application/pdf', 5, 'a'.repeat(64));
  await database.runAsync("INSERT INTO memo_outbox(operation_id,memo_id,operation,payload,state,created_at) VALUES('old-op','legacy','create',?,'pending','2026-10-05T00:00:00Z')", originalPayload);
  await database.closeAsync();
  for (let attempt = 0; attempt < 2; attempt++) {
    database = openSQLite(databasePath);
    try {
      await nativeStorage(async () => database).getDatabase();
      assert.equal((await database.getFirstAsync('SELECT position FROM memo_files')).position, 0);
      assert.equal((await database.getFirstAsync("SELECT payload FROM memo_outbox WHERE operation_id='old-op'")).payload, originalPayload);
      if (attempt === 0) await database.runAsync('INSERT INTO memo_files VALUES(?,?,?,?,?,?,?,?)', 'legacy:11111111-1111-4111-8111-111111111111:file', 'legacy', 'legacy/new.pdf', 'new.pdf', 'application/pdf', 5, 'b'.repeat(64), 1);
      assert.deepEqual((await database.getAllAsync('SELECT name FROM memo_files ORDER BY position')).map((file) => file.name), ['old.pdf', 'new.pdf']);
    } finally { await database.closeAsync(); }
  }
});

test('REQ-052 mixed create survives reopen and failed multi-file update rolls back atomically', async (context) => {
  const directory = isolatedDirectory(context);
  const databasePath = path.join(directory, 'mixed.db');
  let database = openSQLite(databasePath);
  let sequence = 0;
  const objects = new Set();
  const loadMemos = () => loadStorage('memos.native.ts', {
    '@/storage/database.native': nativeStorage(async () => database),
    '@/storage/objects.native': {
      resolveObjectUri: (key) => `private://${key}`,
      persistMemoImages: async (id, uris) => uris.map(() => { const key = `${id}/${++sequence}.png`; objects.add(key); return key; }),
      deleteObjectKeys: (keys) => keys.forEach((key) => objects.delete(key)),
      deleteMemoObjects: (id) => { for (const key of objects) if (key.startsWith(`${id}/`)) objects.delete(key); },
    },
    '@/storage/file-objects.native': { persistMemoFile: async (id, file, revision) => {
      const objectKey = `${id}/${++sequence}.pdf`; objects.add(objectKey);
      return { ...file, id: `${id}:${revision}:file`, objectKey, sha256: 'a'.repeat(64) };
    } },
    '@/storage/file-attachment-rules': { validateFileAttachment: (name, size) => ({ name, size, mediaType: 'application/pdf' }) },
    '@/memos': { extractTags: () => [] },
    '@/sync/uuid': { createUuid: () => `11111111-1111-4111-8111-${String(++sequence).padStart(12, '0')}` },
  });
  const files = ['a', 'b', 'c'].map((name) => ({ uri: `draft-${name}`, name: `${name}.pdf`, mediaType: 'application/pdf', size: 5 }));
  try {
    const memos = loadMemos();
    await memos.addMemo({ id: 'mixed', content: '', createdOn: new Date('2026-10-05T00:00:00Z'), imageUris: ['one', 'two'], fileAttachments: files });
    const memo = await memos.getMemo('mixed');
    assert.equal(memo.imageUris.length, 2);
    assert.deepEqual(Array.from(memo.fileAttachments, (file) => file.name), ['a.pdf', 'b.pdf', 'c.pdf']);
    const queued = JSON.parse((await database.getFirstAsync('SELECT payload FROM memo_outbox')).payload);
    assert.equal(queued.images.length + queued.files.length, 5);
    await assert.rejects(memos.addMemo({ id: 'excess', content: '', createdOn: new Date(), imageUris: ['one', 'two', 'three'], fileAttachments: files }), /5/);
  } finally { await database.closeAsync(); }
  database = openSQLite(databasePath);
  try {
    const memos = loadMemos();
    const memo = await memos.getMemo('mixed');
    assert.equal(memo.imageUris.length, 2);
    assert.equal(memo.fileAttachments.length, 3);
    const originalObjects = [...objects];
    const snapshot = await database.getAllAsync('SELECT * FROM memo_outbox');
    await database.execAsync("CREATE TRIGGER reject_mixed BEFORE INSERT ON memo_outbox BEGIN SELECT RAISE(ABORT, 'mixed write failure'); END;");
    await assert.rejects(memos.updateMemoDraft('mixed', { content: 'changed', imageUris: [], fileAttachments: files }, new Date()), /mixed write failure/);
    assert.deepEqual([...objects], originalObjects);
    assert.deepEqual(await database.getAllAsync('SELECT * FROM memo_outbox'), snapshot);
    assert.equal((await memos.getMemo('mixed')).fileAttachments.length, 3);
    await database.execAsync('DROP TRIGGER reject_mixed');
    await memos.removeMemoFile('mixed', memo.fileAttachments[1].id);
    const afterRemoval = await memos.getMemo('mixed');
    assert.equal(afterRemoval.imageUris.length, 2);
    assert.deepEqual(Array.from(afterRemoval.fileAttachments, (file) => file.name), ['a.pdf', 'c.pdf']);
    await memos.updateMemoDraft('mixed', { content: '', imageUris: [], fileAttachments: [afterRemoval.fileAttachments[0]] }, new Date());
    await memos.removeMemoFile('mixed', afterRemoval.fileAttachments[0].id);
    assert.equal(await memos.getMemo('mixed'), undefined);
    assert.equal((await database.getFirstAsync('SELECT operation FROM memo_outbox ORDER BY rowid DESC')).operation, 'delete');
    assert.deepEqual([...objects], originalObjects, 'queued snapshots retain all original objects until sync');
  } finally { await database.closeAsync(); }
});

function isolatedDirectory(context) {
  const temporary = new URL('../../.tmp/', import.meta.url);
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(path.join(temporary.pathname, 'app-initialization-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('REQ-066 real SQLite keeps trash operations across restart, restore and atomic clear', async (context) => {
  const directory = isolatedDirectory(context);
  const databasePath = path.join(directory, 'trash.db');
  let sequence = 0;
  const loadMemos = (database) => loadStorage('memos.native.ts', {
    '@/storage/database.native': { getDatabase: async () => database },
    '@/storage/objects.native': { persistMemoImages: async () => [], resolveObjectUri: (key) => key, deleteMemoObjects: () => {} },
    '@/storage/file-objects.native': { persistMemoFile: async () => { throw new Error('No file expected'); } },
    '@/storage/file-attachment-rules': { validateFileAttachment: (name, size) => ({ name, size, mediaType: 'application/pdf' }) },
    '@/memos': { extractTags: () => [] },
    '@/sync/uuid': { createUuid: () => `trash-op-${++sequence}` },
  });
  let database = openSQLite(databasePath);
  try {
    await nativeStorage(async () => database).getDatabase();
    const memos = loadMemos(database);
    await memos.addMemo({ id: 'trash-memo', content: 'recover me', imageUris: [], createdOn: new Date('2026-10-01T00:00:00Z') });
    await memos.deleteMemo('trash-memo');
    assert.equal((await memos.getMemos()).length, 0);
    assert.equal((await memos.getTrashMemos())[0].content, 'recover me');
    await memos.restoreMemo('trash-memo');
    assert.equal((await memos.getMemos())[0].id, 'trash-memo');
    await memos.deleteMemo('trash-memo');
    await database.execAsync("CREATE TRIGGER reject_clear BEFORE INSERT ON memo_outbox WHEN NEW.operation='purge' BEGIN SELECT RAISE(ABORT, 'queue failure'); END;");
    await assert.rejects(memos.clearTrashMemos(), /queue failure/);
    assert.equal((await memos.getTrashMemos()).length, 1);
    await database.execAsync('DROP TRIGGER reject_clear');
    await memos.clearTrashMemos();
    assert.equal((await memos.getTrashMemos()).length, 0);
    assert.deepEqual((await database.getAllAsync('SELECT operation FROM memo_outbox ORDER BY rowid')).map((row) => row.operation),
      ['create', 'delete', 'restore', 'delete', 'purge']);
  } finally { await database.closeAsync(); }
  database = openSQLite(databasePath);
  try {
    await nativeStorage(async () => database).getDatabase();
    assert.equal((await loadMemos(database).getTrashMemos()).length, 0);
    assert.equal((await database.getFirstAsync("SELECT COUNT(*) AS count FROM memo_outbox WHERE operation='purge'")).count, 1);
  } finally { await database.closeAsync(); }
});

test('REQ-066 real SQLite pull follows another client without overwriting pending local recovery', async (context) => {
  const directory = isolatedDirectory(context);
  const database = openSQLite(path.join(directory, 'trash-pull.db'));
  const memoId = 'remote-trash-memo';
  const imageId = `${memoId}:0`;
  const fileId = `${memoId}:file`;
  let remoteNotes = [];
  let remoteTrash = [];
  let sequence = 0;
  const removedObjectKeys = [];
  const deletedMemoIds = [];
  const base = { note_id: memoId, content: 'remote content', images: [imageId], files: [fileId],
    file_attachments: [{ id: fileId, name: 'note.pdf', media_type: 'application/pdf', size: 5, sha256: 'a'.repeat(64) }],
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-08T00:00:00Z' };
  const modules = {
    '@/api/memo-sync': { fetchActiveMemos: async () => remoteNotes, fetchTrashMemos: async () => remoteTrash,
      downloadMemoObject: async (_config, path) => path.includes('/objects/')
        ? { mediaType: 'image/png', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]) }
        : { mediaType: 'application/pdf', bytes: Uint8Array.from([37, 80, 68, 70, 45]) } },
    '@/storage/database.native': { getDatabase: async () => database },
    '@/storage/file-objects.native': { hashFileBytes: async () => 'a'.repeat(64) },
    '@/storage/objects.native': { deleteMemoObjects: (id) => deletedMemoIds.push(id), deleteObjectKeys: (keys) => removedObjectKeys.push(...keys),
      persistDownloadedObject: () => `object-${++sequence}`, resolveObjectUri: (key) => key },
    '@/sync/uuid': { createUuid: () => `pull-op-${++sequence}` },
  };
  const loadPull = () => {
    const source = readFileSync(new URL('../../src/sync/memo-pull.native.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`)((specifier) => {
      if (!(specifier in modules)) throw new Error(`Unexpected module: ${specifier}`);
      return modules[specifier];
    }, { exports }, exports);
    return exports.pullRemoteMemos;
  };
  try {
    await nativeStorage(async () => database).getDatabase();
    const pull = loadPull();
    const local = loadStorage('memos.native.ts', {
      ...modules, '@/memos': { extractTags: () => [] },
      '@/storage/file-attachment-rules': { validateFileAttachment: (name, size) => ({ name, size, mediaType: 'application/pdf' }) },
    });
    remoteNotes = [{ ...base, version: 1, deleted_at: null, expires_at: null }];
    await pull({});
    assert.equal((await local.getMemos())[0].content, base.content);
    assert.equal((await local.getMemos())[0].imageUris.length, 1);
    assert.equal((await local.getMemos())[0].fileAttachments[0].name, 'note.pdf');
    const revisedFileId = `${memoId}:11111111-1111-4111-8111-111111111111:file`;
    remoteNotes = [{ ...base, version: 2, deleted_at: null, expires_at: null, images: [imageId, `${memoId}:1`],
      files: [revisedFileId], file_attachments: [{ ...base.file_attachments[0], id: revisedFileId, sha256: 'b'.repeat(64) }] }];
    await assert.rejects(pull({}), /integrity check/);
    assert.equal((await local.getMemos())[0].imageUris.length, 1, 'failed attachment download leaves the local snapshot intact');
    assert.equal(removedObjectKeys.length, 1, 'newly downloaded objects are removed after integrity failure');
    await local.setMemoHidden(memoId, true);
    remoteNotes = [];
    remoteTrash = [{ ...base, version: 2, deleted_at: '2026-10-08T01:00:00Z', expires_at: '2026-11-07T01:00:00Z' }];
    await pull({});
    assert.equal((await local.getTrashMemos())[0].hidden, true);
    await local.restoreMemo(memoId);
    await pull({});
    assert.equal((await local.getMemos())[0].id, memoId, 'pending local restore takes precedence');
    await database.runAsync("UPDATE memo_outbox SET state='acked',result_version=3 WHERE operation='restore'");
    remoteTrash = [];
    remoteNotes = [{ ...base, version: 3, deleted_at: null, expires_at: null }];
    await pull({});
    assert.equal((await local.getMemos())[0].hidden, true);
    remoteNotes = [];
    await pull({});
    assert.equal((await local.getMemos()).length, 0, 'remote purge removes confirmed local copy');
    assert.deepEqual(deletedMemoIds, [memoId], 'remote purge cleans the local attachment directory');
    assert.equal(removedObjectKeys.length, 1, 'unchanged attachments are reused across remote versions');
  } finally { await database.closeAsync(); }
});

test('REQ-066 version conflict rolls back local restore and preserves the failed operation', async (context) => {
  const directory = isolatedDirectory(context);
  const database = openSQLite(path.join(directory, 'trash-conflict.db'));
  let sequence = 0;
  try {
    await nativeStorage(async () => database).getDatabase();
    await database.runAsync(`INSERT INTO memos(id,content,created_at,updated_at,server_version,deleted_at,expires_at)
      VALUES(?,?,?,?,?,?,?)`, 'conflicted', 'keep me', '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z', 2,
      '2026-10-08T00:00:00Z', '2026-11-07T00:00:00Z');
    const storage = loadStorage('memos.native.ts', {
      '@/storage/database.native': { getDatabase: async () => database },
      '@/storage/objects.native': { resolveObjectUri: (key) => key },
      '@/storage/file-attachment-rules': { validateFileAttachment: () => { throw new Error('Unexpected file'); } },
      '@/memos': { extractTags: () => [] }, '@/sync/uuid': { createUuid: () => `conflict-op-${++sequence}` },
    });
    await storage.restoreMemo('conflicted');
    assert.equal((await storage.getMemos()).length, 1);
    const source = readFileSync(new URL('../../src/sync/memo-outbox.native.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const modules = {
      '@/api/memo-sync': {}, 'expo-file-system': {}, '@/storage/database.native': { getDatabase: async () => database },
      '@/storage/objects.native': {}, '@/storage/server-connection': { getServerConnectionConfig: async () => ({ serverApiUrl: 'http://127.0.0.1:1', apiKey: 'fixture' }) },
      '@/sync/memo-pull.native': { pullRemoteMemos: async () => { throw new Error('Must not pull after conflict'); } },
      '@/storage/file-objects.native': {},
      '@/sync/memo-outbox-core': { synchronizeMemoOutbox: async (dependencies) => {
        const rows = await dependencies.getPendingOperations();
        assert.equal(rows.length, 1);
        await dependencies.markFailed(rows[0], { retryable: false, message: 'version_conflict' });
      } },
    };
    const exports = {};
    vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`)((specifier) => {
      if (!(specifier in modules)) throw new Error(`Unexpected module: ${specifier}`);
      return modules[specifier];
    }, { exports }, exports);
    await assert.rejects(exports.syncMemoOutbox(), /version_conflict/);
    assert.equal((await storage.getMemos()).length, 0);
    assert.equal((await storage.getTrashMemos())[0].content, 'keep me');
    assert.deepEqual(await database.getFirstAsync("SELECT operation_id,state,last_error FROM memo_outbox WHERE operation='restore'"),
      { operation_id: 'conflict-op-1', state: 'permanent_failed', last_error: 'version_conflict' });
    await database.runAsync(`INSERT INTO memos(id,content,created_at,updated_at,server_version,hidden)
      VALUES(?,?,?,?,?,1)`, 'hidden-direct', 'private', '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z', 1);
    await database.runAsync('INSERT INTO memo_images(id,memo_id,object_key,position) VALUES(?,?,?,0)',
      'hidden-direct:0', 'hidden-direct', 'hidden-direct/image.png');
    await storage.deleteMemo('hidden-direct');
    assert.equal((await storage.getTrashMemos()).some((memo) => memo.id === 'hidden-direct'), false);
    const hiddenTombstone = await database.getFirstAsync("SELECT deleted_at,purged_at FROM memos WHERE id='hidden-direct'");
    assert.equal(hiddenTombstone.deleted_at, null);
    assert.equal(typeof hiddenTombstone.purged_at, 'string');
    assert.equal((await database.getFirstAsync("SELECT operation FROM memo_outbox WHERE memo_id='hidden-direct'")).operation, 'purge');
    assert.equal((await database.getFirstAsync("SELECT COUNT(*) AS count FROM memo_images WHERE memo_id='hidden-direct'")).count, 1,
      'private attachment stays until Server confirms the purge');
    await assert.rejects(exports.syncMemoOutbox(), /version_conflict/);
    assert.equal((await storage.getMemos()).some((memo) => memo.id === 'hidden-direct'), true,
      'permanent Server rejection restores the hidden note locally');
    assert.deepEqual(await database.getFirstAsync("SELECT operation_id,state,last_error FROM memo_outbox WHERE memo_id='hidden-direct'"),
      { operation_id: 'conflict-op-2', state: 'permanent_failed', last_error: 'version_conflict' });
  } finally { await database.closeAsync(); }
});

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
