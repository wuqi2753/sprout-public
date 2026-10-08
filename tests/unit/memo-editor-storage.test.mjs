// REQ-047: execute native draft updates, including attachment snapshots and rollback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { recordingStartModules } from '../fixtures/recording-start.mjs';

function fixture({ failOutbox = false, failCopy = false } = {}) {
  const state = { content: 'original', createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', images: [{ id: 'memo:0', object_key: 'memo/old.jpg' }], files: [], outbox: [] };
  const objects = new Set(['memo/old.jpg']);
  const deleted = [];
  let sequence = 0;
  let uuidSequence = 0;
  const database = {
    async getAllAsync(sql) {
      if (sql.includes('FROM memos')) return [{ id: 'memo', content: state.content, created_at: state.createdAt, updated_at: state.updatedAt, hidden: 0, synced: 0 }];
      if (sql.includes('FROM memo_images')) return state.images.map((image) => ({ ...image, memo_id: 'memo' }));
      if (sql.includes('FROM memo_files')) return state.files;
      throw new Error(`Unexpected query ${sql}`);
    },
    async withExclusiveTransactionAsync(callback) {
      const snapshot = structuredClone(state);
      try { await callback(this); }
      catch (error) { Object.assign(state, snapshot); throw error; }
    },
    async runAsync(sql, ...parameters) {
      if (sql.startsWith('UPDATE memos')) {
        state.content = parameters[0]; state.updatedAt = parameters[1];
        if (sql.includes('created_at = ?')) state.createdAt = parameters[2];
      }
      else if (sql.startsWith('DELETE FROM memo_images')) state.images = [];
      else if (sql.startsWith('INSERT INTO memo_images')) state.images.push({ id: parameters[0], object_key: parameters[2] });
      else if (sql.startsWith('DELETE FROM memo_files')) state.files = [];
      else if (sql.startsWith('INSERT INTO memo_files')) {
        const [id, memo_id, object_key, name, media_type, size, sha256] = parameters;
        state.files.push({ id, memo_id, object_key, name, media_type, size, sha256 });
      } else if (sql.includes('INSERT INTO memo_outbox')) {
        if (failOutbox) throw new Error('outbox failed');
        state.outbox.push(JSON.parse(parameters[2]));
      } else throw new Error(`Unexpected write ${sql}`);
      return { changes: 1 };
    },
  };
  const modules = {
    ...recordingStartModules(),
    '@/storage/database.native': { getDatabase: async () => database },
    '@/storage/objects.native': {
      resolveObjectUri: (key) => `private://${key}`,
      persistMemoImages: async () => {
        if (failCopy) throw new Error('copy failed');
        const key = `memo/new-${++sequence}.jpg`; objects.add(key); return [key];
      },
      deleteObjectKeys: (keys) => { for (const key of keys) { deleted.push(key); objects.delete(key); } },
    },
    '@/storage/file-objects.native': { persistMemoFile: async (id, file, revision) => {
      const objectKey = `memo/new-${++sequence}.pdf`; objects.add(objectKey);
      return { ...file, id: `${id}:${revision}:file`, objectKey, sha256: 'a'.repeat(64) };
    } },
    '@/storage/file-attachment-rules': { validateFileAttachment: (name, size) => ({ name, size, mediaType: 'application/pdf' }) },
    '@/memos': { extractTags: () => [] },
    '@/sync/uuid': { createUuid: () => `11111111-1111-4111-8111-${String(++uuidSequence).padStart(12, '0')}` },
  };
  const exports = {};
  const source = readFileSync(new URL('../../src/storage/memos.native.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`)((name) => {
    if (!modules[name]) throw new Error(`Unexpected import ${name}`);
    return modules[name];
  }, { exports }, exports);
  return { storage: exports, state, objects, deleted };
}

const savedAt = new Date('2026-10-05T01:00:00Z');
test('REQ-069 time-only edit persists seconds with attachments and snapshots the recording time', async () => {
  const { storage, state } = fixture();
  const createdOn = new Date('2024-02-29T23:59:47Z');
  await storage.updateMemoDraft('memo', { content: 'original', imageUris: ['private://memo/old.jpg'], createdOn }, savedAt);
  assert.equal(state.createdAt, createdOn.toISOString());
  assert.equal(state.updatedAt, savedAt.toISOString());
  assert.equal(state.outbox[0].created_at, createdOn.toISOString());
  assert.equal(state.images[0].id, 'memo:0');
  assert.equal((await storage.getMemo('memo')).createdOn.getTime(), createdOn.getTime());
  await storage.updateMemoDraft('memo', { content: 'changed', imageUris: ['private://memo/old.jpg'] }, savedAt);
  assert.equal(state.createdAt, createdOn.toISOString());
  assert.equal(state.outbox[1].created_at, undefined);
});
test('REQ-069 invalid date and failed outbox leave the recording time untouched', async () => {
  const { storage, state } = fixture({ failOutbox: true });
  const original = state.createdAt;
  await assert.rejects(storage.updateMemoDraft('memo', { content: 'original', imageUris: [], createdOn: new Date(NaN) }, savedAt), /记录时间无效/);
  await assert.rejects(storage.updateMemoDraft('memo', { content: 'original', imageUris: [], createdOn: new Date('2024-01-01Z') }, savedAt), /outbox failed/);
  assert.equal(state.createdAt, original);
  assert.equal(state.outbox.length, 0);
});
// REQ-052: mixed snapshots preserve independent file identities and queued originals.
test('REQ-052 two images and three files save, rename and remove only the target file', async () => {
  const { storage, state, objects } = fixture();
  await storage.updateMemoDraft('memo', { content: '', imageUris: ['new-photo', 'private://memo/old.jpg'],
    fileAttachments: ['a', 'b', 'c'].map((name) => ({ uri: `draft-${name}`, name: `${name}.pdf`, size: 10, mediaType: 'application/pdf' })) }, savedAt);
  assert.equal(state.images.length, 2);
  assert.equal(state.files.length, 3);
  assert.equal(new Set(state.files.map((file) => file.id)).size, 3);
  const originals = structuredClone(state.files);
  const firstSnapshot = structuredClone(state.outbox[0]);
  await storage.renameMemoFile('memo', originals[1].id, 'renamed');
  assert.deepEqual(state.files.map((file) => file.name), ['a.pdf', 'renamed.pdf', 'c.pdf']);
  assert.equal(state.files[0].id, originals[0].id);
  assert.equal(state.files[2].id, originals[2].id);
  await storage.removeMemoFile('memo', state.files[1].id);
  assert.deepEqual(state.files.map((file) => file.id), [originals[0].id, originals[2].id]);
  assert.equal(state.images.length, 2);
  assert.deepEqual(state.outbox[0], firstSnapshot);
  assert.ok(originals.every((file) => objects.has(file.object_key)));
  await assert.rejects(storage.removeMemoFile('memo', 'missing:file'), /不存在/);
});

test('REQ-052 accepts five files or five images and rejects six before copying', async () => {
  const { storage, state, objects } = fixture();
  const files = Array.from({ length: 5 }, (_, index) => ({ uri: `draft-${index}`, name: `${index}.pdf`, size: 10, mediaType: 'application/pdf' }));
  await storage.updateMemoDraft('memo', { content: '', imageUris: [], fileAttachments: files }, savedAt);
  assert.equal(state.files.length, 5);
  assert.equal(new Set(state.files.map((file) => file.id)).size, 5);
  const snapshot = structuredClone(state);
  const objectCount = objects.size;
  await assert.rejects(storage.updateMemoDraft('memo', { content: '', imageUris: ['sixth'], fileAttachments: files }, savedAt), /5/);
  assert.deepEqual(state, snapshot);
  assert.equal(objects.size, objectCount);
  await storage.updateMemoDraft('memo', { content: '', imageUris: ['one', 'two', 'three', 'four', 'five'] }, savedAt);
  assert.equal(state.images.length, 5);
  assert.equal(state.files.length, 0);
});

test('REQ-052 failed mixed save cleans every new object and retains original relations', async () => {
  const { storage, state, objects } = fixture({ failOutbox: true });
  await assert.rejects(storage.updateMemoDraft('memo', { content: 'changed', imageUris: ['new'],
    fileAttachments: ['a', 'b'].map((name) => ({ uri: name, name: `${name}.pdf`, size: 10, mediaType: 'application/pdf' })) }, savedAt), /outbox failed/);
  assert.equal(state.content, 'original');
  assert.equal(state.files.length, 0);
  assert.deepEqual([...objects], ['memo/old.jpg']);
});
// REQ-049: rename versions metadata without mutating pending snapshots.
test('file rename retains extension and old snapshot; rejects invalid names', async () => {
  const { storage, state, objects } = fixture();
  await storage.updateMemoDraft('memo', { content: '', imageUris: [], fileAttachments: [{ uri: 'draft', name: 'first.pdf', size: 10, mediaType: 'application/pdf' }] }, savedAt);
  const previous = { ...state.files[0] };
  await storage.renameMemoFile('memo', state.files[0].id, '  新名称  ');
  assert.equal(state.files[0].name, '新名称.pdf');
  assert.equal(state.files[0].sha256, previous.sha256);
  assert.equal(state.files[0].size, previous.size);
  assert.notEqual(state.files[0].id, previous.id);
  assert.ok(objects.has(previous.object_key));
  assert.equal(state.outbox[0].file_objects[0].name, 'first.pdf');
  assert.equal(state.outbox[1].file_objects[0].name, '新名称.pdf');
  await storage.renameMemoFile('memo', state.files[0].id, '新名称');
  assert.equal(state.outbox.length, 2);
  for (const name of ['', ' ', 'a/b', 'a\\b', 'a\u0000b']) await assert.rejects(storage.renameMemoFile('memo', state.files[0].id, name), /名称/);
  assert.equal(state.files[0].name, '新名称.pdf');
});

test('rename failure restores original file name and removes the new copy', async () => {
  const { storage, state, objects } = fixture({ failOutbox: true });
  state.images = [];
  state.files = [{ id: 'memo:file', memo_id: 'memo', object_key: 'memo/original.pdf', name: 'original.pdf', media_type: 'application/pdf', size: 10, sha256: 'a'.repeat(64) }];
  objects.add('memo/original.pdf');
  await assert.rejects(storage.renameMemoFile('memo', state.files[0].id, 'changed'), /outbox failed/);
  assert.equal(state.files[0].name, 'original.pdf');
  assert.equal(state.outbox.length, 0);
  assert.equal(objects.size, 2);
});

test('attachment-only save keeps old IDs, versions new images and snapshots their bytes', async () => {
  const { storage, state, objects } = fixture();
  await storage.updateMemoDraft('memo', { content: '', imageUris: ['new-photo', 'private://memo/old.jpg'] }, savedAt);
  assert.equal(state.content, '');
  assert.match(state.images[0].id, /^memo:[a-f0-9-]+:0$/);
  assert.equal(state.images[1].id, 'memo:0');
  assert.deepEqual(state.outbox[0].images, state.images.map((image) => image.id));
  assert.deepEqual(state.outbox[0].image_objects, state.images);
  assert.deepEqual(state.outbox[0].files, []);
  assert.ok(objects.has('memo/old.jpg'));
});

test('replacing a file uses a new ID and removing it sends an explicit empty files array', async () => {
  const { storage, state, objects } = fixture();
  await storage.updateMemoDraft('memo', { content: '', imageUris: [], fileAttachments: [{ uri: 'draft', name: 'first.pdf', size: 10, mediaType: 'application/pdf' }] }, savedAt);
  const firstKey = state.files[0].object_key;
  const firstId = state.files[0].id;
  assert.match(state.files[0].id, /^memo:[a-f0-9-]+:file$/);
  assert.deepEqual(state.outbox[0].images, []);
  await storage.updateMemoDraft('memo', { content: '', imageUris: [], fileAttachments: [{ uri: 'another-draft', name: 'second.pdf', size: 11, mediaType: 'application/pdf' }] }, savedAt);
  assert.notEqual(state.files[0].id, firstId);
  assert.notEqual(state.files[0].object_key, firstKey);
  await storage.updateMemoDraft('memo', { content: 'text', imageUris: [] }, savedAt);
  assert.equal(state.files.length, 0);
  assert.deepEqual(state.outbox[2].files, []);
  assert.ok(objects.has(firstKey));
  assert.equal(state.outbox[0].file_objects[0].object_key, firstKey);
});

test('failed Outbox commit restores content and relations and deletes only newly copied objects', async () => {
  const { storage, state, objects, deleted } = fixture({ failOutbox: true });
  await assert.rejects(storage.updateMemoDraft('memo', { content: 'changed', imageUris: ['replacement'] }, savedAt), /outbox failed/);
  assert.equal(state.content, 'original');
  assert.equal(state.images[0].object_key, 'memo/old.jpg');
  assert.deepEqual([...objects], ['memo/old.jpg']);
  assert.equal(deleted.length, 1);
  assert.equal(state.outbox.length, 0);
});

test('copy failure and invalid drafts preserve existing content and objects', async () => {
  const { storage, state, objects } = fixture({ failCopy: true });
  await assert.rejects(storage.updateMemoDraft('memo', { content: 'changed', imageUris: ['new'] }, savedAt), /copy failed/);
  await assert.rejects(storage.updateMemoDraft('memo', { content: '', imageUris: [] }, savedAt), /不能为空/);
  await assert.rejects(storage.updateMemoDraft('memo', { content: 'text', imageUris: Array(10).fill('new') }, savedAt), /无效/);
  assert.equal(state.content, 'original');
  assert.deepEqual([...objects], ['memo/old.jpg']);
  assert.equal(state.outbox.length, 0);
});

test('selecting an existing photo twice gives the second copy its own immutable ID', async () => {
  const { storage, state } = fixture();
  await storage.updateMemoDraft('memo', { content: '', imageUris: ['private://memo/old.jpg', 'private://memo/old.jpg'] }, savedAt);
  assert.equal(state.images.length, 2);
  assert.notEqual(state.images[0].id, state.images[1].id);
  assert.notEqual(state.images[0].object_key, state.images[1].object_key);
});

test('browser draft cancellation has no effect; saving allows image-only content', async () => {
  const exports = {};
  const source = readFileSync(new URL('../../src/storage/memos.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const browserModules = { ...recordingStartModules(), '@/memos': { extractTags: () => [] }, '@/sync/uuid': { createUuid: () => 'uuid' } };
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`)((name) => {
    if (!(name in browserModules)) throw new Error(`Unexpected browser import ${name}`);
    return browserModules[name];
  }, { exports }, exports);
  await exports.addMemo({ id: 'memo', content: 'original', imageUris: [], createdOn: savedAt });
  const draft = { content: '', imageUris: ['photo'] };
  assert.equal((await exports.getMemo('memo')).content, 'original');
  await exports.updateMemoDraft('memo', draft, savedAt);
  draft.imageUris.push('later');
  assert.equal((await exports.getMemo('memo')).imageUris.length, 1);
  assert.equal((await exports.getMemo('memo')).content, '');
});
