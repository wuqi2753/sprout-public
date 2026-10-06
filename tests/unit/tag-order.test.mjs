// REQ-059: custom order, draft moves and storage validation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/storage/tag-order-rules.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(`(function(exports) { ${compiled}\n})`)(exports);
const { orderTags, moveTag, readTagOrder, tagOrderToSave } = exports;
const tags = [{ name: 'a', count: 2 }, { name: 'b', count: 4 }, { name: 'c', count: 2 }];
test('REQ-059 defaults by count then name and appends new tags, omitting vanished tags', () => {
  assert.deepEqual(Array.from(orderTags(tags, []), t => t.name), ['b', 'a', 'c']);
  assert.deepEqual(Array.from(orderTags(tags, ['c', 'missing', 'a']), t => t.name), ['c', 'a', 'b']);
  assert.deepEqual(tags.map(t => t.name), ['a', 'b', 'c']);
  assert.equal(orderTags([], ['missing']).length, 0);
});
test('REQ-059 moves drafts without mutating saved order and validates positions', () => {
  const saved = ['a', 'b', 'c'];
  assert.equal(JSON.stringify(moveTag(saved, 0, 2)), '["b","c","a"]');
  assert.equal(JSON.stringify(moveTag(saved, 2, 0)), '["c","a","b"]');
  assert.deepEqual(saved, ['a', 'b', 'c']);
  assert.throws(() => moveTag(saved, -1, 0));
  assert.throws(() => moveTag(saved, 0, 3));
});
test('REQ-059 saving default keeps count ordering dynamic after reload', () => {
  const defaultNames = Array.from(orderTags(tags, []), t => t.name);
  const saved = readTagOrder(JSON.stringify(tagOrderToSave(defaultNames, defaultNames)));
  assert.equal(saved.length, 0);
  const updated = [{ name: 'a', count: 8 }, { name: 'b', count: 4 }, { name: 'c', count: 9 }];
  assert.deepEqual(Array.from(orderTags(updated, saved), t => t.name), ['c', 'a', 'b']);
  const custom = tagOrderToSave(['a', 'c', 'b'], defaultNames);
  assert.deepEqual(Array.from(orderTags(updated, custom), t => t.name), ['a', 'c', 'b']);
});
test('REQ-059 storage roundtrip preserves order and rejects malformed preferences', () => {
  assert.equal(JSON.stringify(readTagOrder('["c","a","b"]')), '["c","a","b"]');
  assert.equal(readTagOrder(null).length, 0);
  for (const value of ['{}', '["a","a"]', '[1]', '[""]', 'broken']) assert.throws(() => readTagOrder(value));
});
