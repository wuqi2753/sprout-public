// REQ-063: actual memo counting, privacy and creation-day grouping.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/components/tag-growth-rules.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(`(function(exports) { ${compiled}\n})`, { Date, Map, Set })(exports);
const { tagGrowthRecords } = exports;
const today = new Date(2026, 9, 6);
test('REQ-063 overall counts memos once; multiple tags overlap and hidden memos are excluded', () => {
  const result = tagGrowthRecords([
    { createdOn: new Date(2026, 9, 5, 23, 59), tags: ['理财', '健康', '理财'] },
    { createdOn: new Date(2026, 9, 6, 0, 1), tags: ['理财'] },
    { createdOn: today, tags: [] },
    { createdOn: today, tags: ['私密'], hidden: true },
  ], today);
  assert.equal(result.tagNames.join(), '全部,理财,健康');
  assert.equal(result.tagTotals.join(), '3,2,1');
  assert.equal(result.recordedDays.length, 2);
  assert.equal(result.recordedDays[0].counts.join(), '1,1,1');
  assert.equal(result.recordedDays[1].counts.join(), '2,1,0');
  assert.equal(result.recordedDays[0].date.getHours(), 0);
});
test('REQ-063 empty and hidden-only libraries contain no mock tags or counts', () => {
  for (const memos of [[], [{ createdOn: today, tags: ['私密'], hidden: true }]]) {
    const result = tagGrowthRecords(memos, today);
    assert.equal(result.tagNames.join(), '全部');
    assert.equal(result.tagTotals.join(), '0');
    assert.equal(result.recordedDays.length, 0);
  }
});
test('REQ-063 changed tags and creation dates recompute actual growth without mutating memos', () => {
  const memo = { createdOn: new Date(2026, 0, 1), tags: ['旧标签'] };
  const before = memo.createdOn.getTime();
  tagGrowthRecords([memo], today);
  assert.equal(memo.createdOn.getTime(), before);
  assert.equal(memo.tags.join(), '旧标签');
  const result = tagGrowthRecords([{ ...memo, tags: ['新标签'], createdOn: today }], today);
  assert.equal(result.tagNames.join(), '全部,新标签');
  assert.equal(result.recordedDays[0].date.getDate(), 6);
});
test('REQ-063 invalid and future ordinary memo dates fail explicitly', () => {
  assert.throws(() => tagGrowthRecords([{ createdOn: new Date('invalid'), tags: [] }], today), /日期无效/);
  assert.throws(() => tagGrowthRecords([{ createdOn: new Date(2026, 9, 7), tags: [] }], today), /晚于今天/);
});
