// REQ-062: date placement, density thresholds and future-day boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/components/recording-heatmap-rules.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(`(function(exports) { ${compiled}\n})`, { Date, Map })(exports);
const { recordingHeatmap, heatmapIntensity, recordingDateKey } = exports;
test('REQ-062 thirteen Monday-first weeks contain today exactly once and disable future days', () => {
  for (const today of [new Date(2026, 9, 5), new Date(2027, 0, 1), new Date(2024, 1, 29), new Date(2026, 2, 9)]) {
    const weeks = recordingHeatmap([], today);
    assert.equal(weeks.length, 13);
    assert.ok(weeks.every((week) => week.length === 7 && week[0].date.getDay() === 1));
    assert.equal(weeks.flat().filter((cell) => cell.today).length, 1);
    assert.equal(weeks.flat().filter((cell) => cell.future).length, 6 - (today.getDay() + 6) % 7);
    const keys = weeks.flat().map((cell) => cell.key);
    assert.equal(new Set(keys).size, 91);
    assert.ok(keys.every((key, index) => index === 0 || key > keys[index - 1]));
  }
});
test('REQ-062 real counts use local dates and fixed density thresholds', () => {
  assert.equal([0, 1, 2, 3, 4, 6, 7, 100].map(heatmapIntensity).join(), '0,1,2,2,3,3,4,4');
  const today = new Date(2026, 9, 5);
  const dates = [new Date(2026, 9, 3, 0, 1), new Date(2026, 9, 3, 23, 59), new Date(2026, 9, 5)];
  const cells = recordingHeatmap(dates, today).flat();
  const saturday = cells.find((cell) => cell.key === '2026-10-03');
  assert.equal(saturday.count, 2); assert.equal(saturday.intensity, 2);
  assert.equal(cells.find((cell) => cell.today).count, 1);
  assert.equal(recordingDateKey(new Date(2026, 0, 2)), '2026-01-02');
  assert.throws(() => recordingHeatmap([new Date(2026, 9, 6)], today), /晚于今天/);
  assert.throws(() => recordingDateKey(new Date('bad')), /日期无效/);
  for (const count of [-1, 0.5, NaN]) assert.throws(() => heatmapIntensity(count));
});
