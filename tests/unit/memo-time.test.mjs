// REQ-069: execute date conversion and clamping, including leap years.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/memos/memo-time.ts', import.meta.url), 'utf8');
const exports = {};
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(`(function(exports) { ${compiled}\n})`)(exports);
test('REQ-069 month and leap-year changes clamp the day', () => {
  assert.equal(exports.changeMemoTimePart([2024, 1, 31, 23, 59, 47], 1, 2)[2], 29);
  assert.equal(exports.changeMemoTimePart([2024, 2, 29, 23, 59, 47], 0, 2025)[2], 28);
  assert.equal(exports.daysInMemoMonth(2000, 2), 29);
  assert.equal(exports.daysInMemoMonth(2100, 2), 28);
});
test('REQ-069 local date conversion preserves seconds and rejects invalid values', () => {
  const parts = [2024, 2, 29, 23, 59, 47];
  assert.deepEqual(Array.from(exports.memoTimeParts(exports.memoDateFromParts(parts))), parts);
  for (const invalid of [[2025, 2, 29, 0, 0, 0], [2024, 13, 1, 0, 0, 0], [2024, 1, 1, 24, 0, 0]]) {
    assert.throws(() => exports.memoDateFromParts(invalid), /日期或时间无效/);
  }
});
