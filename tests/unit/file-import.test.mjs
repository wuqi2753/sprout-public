// REQ-040: validate actual copied size, cancellation and provider failures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createHash } from 'node:crypto';

function load(relativePath, modules = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(require, exports) { ${compiled}\n})`, { URL })((name) => {
    assert.ok(name in modules, `Unexpected import ${name}`);
    return modules[name];
  }, exports);
  return exports;
}
const rules = load('../../src/storage/file-attachment-rules.ts');

test('ordinary file names and size boundaries, including CSV and Excel', () => {
  for (const extension of ['pdf', 'xls', 'xlsx', 'csv']) {
    assert.equal(rules.validateFileAttachment(`/Downloads/账单.${extension}`, 20 * 1024 * 1024).name, `账单.${extension}`);
  }
  for (const size of [0, -1, NaN, Infinity, 20 * 1024 * 1024 + 1]) {
    assert.throws(() => rules.validateFileAttachment('bill.pdf', size));
  }
  for (const name of ['bill.zip', 'bill.pdf.exe', 'bad\n.pdf', '']) assert.throws(() => rules.validateFileAttachment(name, 1));
});

function importEnvironment(size, pickerResult, copyFailure = false) {
  let sequence = 0;
  const files = new Map([['content://provider/file', { size, exists: true }]]);
  class Directory {
    constructor(...parts) { this.uri = parts.map((part) => part.uri ?? part).join('/'); }
    create() {}
    get exists() { return [...files.keys()].some((uri) => uri.startsWith(this.uri + '/')); }
    delete() { for (const uri of files.keys()) if (uri.startsWith(this.uri + '/')) files.delete(uri); }
  }
  class File {
    constructor(...parts) { this.uri = parts.map((part) => part.uri ?? part).join('/'); }
    get size() { return files.get(this.uri)?.size ?? 0; }
    get exists() { return files.has(this.uri); }
    async copy(destination) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (copyFailure) throw new Error('provider read denied');
      files.set(destination.uri, { size: this.size, exists: true });
    }
    delete() { files.delete(this.uri); }
  }
  const imported = load('../../src/storage/import-file.native.ts', {
    'expo-file-system': { File, Directory, Paths: { cache: { uri: 'file://cache' } } },
    'expo-document-picker': { getDocumentAsync: async () => pickerResult },
    '@/sync/uuid': { createUuid: () => `unique-import-${++sequence}` },
    '@/storage/file-attachment-rules': rules,
  });
  return { imported, files };
}

test('picker cancellation creates no copy; selected content URI is copied with safe name', async () => {
  const canceled = importEnvironment(5, { canceled: true });
  assert.equal((await canceled.imported.chooseFileAttachments(5)).length, 0);
  assert.equal(canceled.files.size, 1);
  const selected = importEnvironment(123, { canceled: false, assets: [{ uri: 'content://provider/file', name: '账单.PDF', size: 123 }] });
  const [attachment] = await selected.imported.chooseFileAttachments(5);
  assert.equal(attachment.size, 123);
  assert.equal(attachment.mediaType, 'application/pdf');
  assert.equal(attachment.uri, 'file://cache/file-imports/unique-import-1');
  selected.imported.discardImportedFile(attachment);
  assert.equal(selected.files.size, 1);
});

test('REQ-052 multi-select rejects excess and rolls back partial invalid selection', async () => {
  const assets = ['a.pdf', 'b.pdf', 'c.pdf'].map((name) => ({ uri: 'content://provider/file', name, size: 10 }));
  const environment = importEnvironment(10, { canceled: false, assets });
  await assert.rejects(environment.imported.chooseFileAttachments(2), /还可添加 2/);
  assert.equal(environment.files.size, 1);
  const attachments = await environment.imported.chooseFileAttachments(3);
  assert.deepEqual(Array.from(attachments, (file) => file.name), ['a.pdf', 'b.pdf', 'c.pdf']);
  assert.equal(new Set(attachments.map((file) => file.uri)).size, 3);
  attachments.forEach(environment.imported.discardImportedFile);
  assert.equal(environment.files.size, 1);
  const invalid = importEnvironment(10, { canceled: false, assets: [assets[0], { ...assets[1], name: 'unsupported.zip' }] });
  await assert.rejects(invalid.imported.chooseFileAttachments(2), /PDF|支持/);
  assert.equal(invalid.files.size, 1);
});

test('untrusted declared size cannot hide oversized content; rejected copy cleaned up', async () => {
  const environment = importEnvironment(20 * 1024 * 1024 + 1);
  await assert.rejects(environment.imported.copyIncomingFile('content://provider/file', 'bill.pdf', 1), /20 MiB/);
  assert.equal(environment.files.size, 1);
  await assert.rejects(environment.imported.copyIncomingFile('https://example.com/bill.pdf', 'bill.pdf'), /下载/);
  const failed = importEnvironment(5, undefined, true);
  await assert.rejects(failed.imported.copyIncomingFile('content://provider/file', 'bill.pdf'), /denied/);
  assert.equal(failed.files.size, 1);
});

test('REQ-040 abandoned caches are removed without touching provider originals or durable objects', () => {
  const environment = importEnvironment(5);
  for (const uri of ['file://cache/file-imports/old', 'file://cache/file-previews/old/document.pdf',
    'file://documents/sprout/objects/memo/file.pdf', 'file://cache/unrelated/file.pdf']) {
    environment.files.set(uri, { size: 5 });
  }
  environment.imported.discardAbandonedAttachmentCaches();
  assert.equal(environment.files.size, 3);
  assert.ok(environment.files.has('content://provider/file'));
  assert.ok(environment.files.has('file://documents/sprout/objects/memo/file.pdf'));
  assert.ok(environment.files.has('file://cache/unrelated/file.pdf'));
});

// REQ-041: real async ordering matters for durable storage and external preview too.
function attachmentEnvironment(copyFailure = false) {
  const original = new Uint8Array([37, 80, 68, 70, 45]);
  const files = new Map([['file:///source.pdf', original]]);
  class Directory {
    constructor(...parts) { this.uri = parts.map((part) => part.uri ?? part).join('/'); }
    create() {}
    get exists() { return [...files.keys()].some((uri) => uri.startsWith(this.uri + '/')); }
    delete() { for (const uri of files.keys()) if (uri.startsWith(this.uri + '/')) files.delete(uri); }
  }
  class File {
    constructor(...parts) { this.uri = parts.map((part) => part.uri ?? part).join('/'); }
    get exists() { return files.has(this.uri); }
    get size() { return files.get(this.uri)?.byteLength ?? 0; }
    async copy(destination) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (copyFailure) throw new Error('copy failed');
      files.set(destination.uri, files.get(this.uri).slice());
    }
    async arrayBuffer() {
      assert.ok(this.exists, 'must await copy before reading bytes');
      return files.get(this.uri).slice().buffer;
    }
    delete() { files.delete(this.uri); }
  }
  const modules = {
    'expo-file-system': { File, Directory, Paths: { cache: 'file:///cache', document: 'file:///documents' } },
    '@/sync/uuid': { createUuid: () => 'unique-copy' },
    '@/storage/file-attachment-rules': rules,
    '@/storage/objects.native': { resolveObjectUri: (key) => `file:///documents/sprout/objects/${key}` },
    'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digest: async (_, bytes) => {
      assert.ok(ArrayBuffer.isView(bytes), 'Android digest requires a TypedArray');
      return Uint8Array.from(createHash('sha256').update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest()).buffer;
    } },
  };
  return { files, modules, original, attachment: { uri: 'file:///source.pdf', name: 'source.pdf', mediaType: 'application/pdf', size: original.byteLength } };
}

test('REQ-041 durable copy awaits bytes and retains the original on copy failure', async () => {
  const environment = attachmentEnvironment();
  const storage = load('../../src/storage/file-objects.native.ts', environment.modules);
  const saved = await storage.persistMemoFile('memo-1', environment.attachment);
  assert.equal(saved.sha256, createHash('sha256').update(environment.original).digest('hex'));
  assert.deepEqual(environment.files.get(saved.uri), environment.original);
  assert.equal(environment.files.size, 2);
  const failed = attachmentEnvironment(true);
  await assert.rejects(load('../../src/storage/file-objects.native.ts', failed.modules).persistMemoFile('memo-1', failed.attachment), /copy failed/);
  assert.equal(failed.files.size, 1);
});

test('REQ-041 preview waits for disposable copy and removes it when returning to App', async () => {
  const environment = attachmentEnvironment();
  let onStateChange;
  let subscriptionRemoved = false;
  environment.modules['react-native'] = {
    Platform: { OS: 'android' },
    AppState: { addEventListener: (_, callback) => { onStateChange = callback; return { remove: () => { subscriptionRemoved = true; } }; } },
  };
  environment.modules['@magrinj/expo-quick-look'] = {
    canPreview: async (uri) => { assert.ok(environment.files.has(uri), 'must await preview copy'); return true; },
    previewFile: async ({ uri, editingMode }) => { assert.equal(editingMode, 'disabled'); assert.notEqual(uri, environment.attachment.uri); },
  };
  await load('../../src/storage/open-file.native.ts', environment.modules).openFileAttachment(environment.attachment);
  assert.equal(environment.files.size, 2);
  onStateChange('active');
  assert.equal(environment.files.size, 1);
  assert.ok(subscriptionRemoved);
  assert.deepEqual(environment.files.get(environment.attachment.uri), environment.original);
  environment.modules['@magrinj/expo-quick-look'].canPreview = async () => false;
  await assert.rejects(load('../../src/storage/open-file.native.ts', environment.modules).openFileAttachment(environment.attachment), /阅读器/);
  assert.equal(environment.files.size, 1);
  environment.modules['@magrinj/expo-quick-look'].canPreview = async () => true;
  subscriptionRemoved = false;
  environment.modules['@magrinj/expo-quick-look'].previewFile = async () => { onStateChange('active'); };
  await load('../../src/storage/open-file.native.ts', environment.modules).openFileAttachment(environment.attachment);
  assert.ok(subscriptionRemoved, 'Listener must be registered before a fast return');
  assert.equal(environment.files.size, 1);
  subscriptionRemoved = false;
  environment.modules['@magrinj/expo-quick-look'].previewFile = async () => { throw new Error('reader launch failed'); };
  await assert.rejects(load('../../src/storage/open-file.native.ts', environment.modules).openFileAttachment(environment.attachment), /launch failed/);
  assert.ok(subscriptionRemoved, 'Failed launch must release listener');
  assert.equal(environment.files.size, 1);
});
