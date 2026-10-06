// REQ-055: recent keyword persistence and validation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../../src/storage/search-history-rules.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(`(function(exports) { ${compiled} })`)(exports);
const { addRecentSearch, readSearchHistory } = exports;

test('REQ-055 recent searches trim, deduplicate, reorder and retain only ten keywords', () => {
  const keywords = Array.from({ length: 10 }, (_, index) => `keyword${index}`);
  assert.deepEqual(Array.from(addRecentSearch(keywords, ' keyword5 ')), ['keyword5', ...keywords.filter((word) => word !== 'keyword5')]);
  assert.deepEqual(Array.from(addRecentSearch(keywords, 'new')), ['new', ...keywords.slice(0, 9)]);
  assert.equal(addRecentSearch(keywords, '   '), keywords);
});

test('REQ-055 saved history round trips and rejects corrupted local values', () => {
  assert.deepEqual(Array.from(readSearchHistory(null)), []);
  assert.deepEqual(Array.from(readSearchHistory(JSON.stringify(['工作', '#想法']))), ['工作', '#想法']);
  for (const value of ['{}', '[1]', '[" "]', '[" word"]', '["a","a"]', 'invalid', JSON.stringify(Array.from({ length: 11 }, (_, index) => `${index}`))]) {
    assert.throws(() => readSearchHistory(value));
  }
});

test('REQ-055 persistence survives reload, isolates partitions and clears only one partition', async () => {
  const stored = new Map();
  const loadStorage = () => {
    const source = readFileSync(new URL('../../src/storage/search-history.ts', import.meta.url), 'utf8');
    const compiledStorage = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const storageExports = {};
    vm.runInNewContext(`(function(require, exports) { ${compiledStorage} })`, { window: { localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } } })(() => exports, storageExports);
    return storageExports;
  };
  const storage = loadStorage();
  await storage.saveSearchHistory('ordinary', ['工作']);
  await storage.saveSearchHistory('hidden', ['私密']);
  assert.deepEqual(Array.from(await loadStorage().getSearchHistory('ordinary')), ['工作']);
  await storage.saveSearchHistory('ordinary', []);
  assert.deepEqual(Array.from(await storage.getSearchHistory('ordinary')), []);
  assert.deepEqual(Array.from(await storage.getSearchHistory('hidden')), ['私密']);
});
