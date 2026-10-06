// REQ-061: natural days, hidden counts, validation and retained starting date.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/storage/memo-statistics-rules.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(`(function(exports) { ${compiled}\n})`, { Date, Set })(exports);
const { earliestRecordingDate, calculateMemoStatistics } = exports;
const memo = (date, tags = [], hidden = false) => ({ createdOn: new Date(date), tags, hidden });
test('REQ-061 counts ordinary notes and unique tags but includes hidden dates', () => {
  const result = calculateMemoStatistics([
    memo('2026-10-03', ['a', 'b']), memo('2026-10-04', ['a']), memo('2026-10-01', ['secret'], true),
  ], null, new Date('2026-10-05'));
  assert.equal(result.memoCount, 2); assert.equal(result.tagCount, 2); assert.equal(result.recordingDays, 5);
});
test('REQ-061 first day, empty state, midnight and calendar boundaries', () => {
  assert.equal(calculateMemoStatistics([], null).recordingDays, 0);
  for (const [start, end, days] of [
    [new Date(2026, 9, 1), new Date(2026, 9, 1), 1],
    [new Date(2026, 9, 1, 23, 59), new Date(2026, 9, 2, 0, 1), 2],
    [new Date(2026, 11, 31), new Date(2027, 0, 1), 2],
    [new Date(2024, 1, 28), new Date(2024, 2, 1), 3],
    [new Date(2026, 2, 7, 23, 59), new Date(2026, 2, 9, 0, 1), 3],
  ]) assert.equal(calculateMemoStatistics([], start.toISOString(), end).recordingDays, days);
});
test('REQ-061 deletion preserves the date, older sync advances it, and invalid dates fail', () => {
  const today = new Date('2026-10-05');
  const saved = earliestRecordingDate(null, [new Date('2026-10-03')], today);
  assert.equal(earliestRecordingDate(saved, [], today), saved);
  assert.equal(calculateMemoStatistics([], saved, today).recordingDays, 3);
  assert.equal(earliestRecordingDate(saved, [new Date('2026-10-01')], today), '2026-10-01T00:00:00.000Z');
  assert.throws(() => earliestRecordingDate('broken', [], today), /createdOn/);
  assert.throws(() => earliestRecordingDate(null, [new Date('broken')], today), /createdOn/);
  assert.throws(() => earliestRecordingDate(null, [new Date('2026-10-06')], today), /晚于今天/);
});

test('REQ-061 native storage survives reload, serializes older observations and reports write failures', async () => {
  let contents = null;
  let failWrite = false;
  const fileSystem = { Paths: { document: 'private' }, File: class {
    get exists() { return contents !== null; }
    async text() { return contents; }
    write(value) { if (failWrite) throw new Error('disk full'); contents = value; }
  } };
  function loadStorage() {
    const storageSource = readFileSync(new URL('../../src/storage/recording-start.native.ts', import.meta.url), 'utf8');
    const storageCompiled = ts.transpileModule(storageSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const storageExports = {};
    vm.runInNewContext(`(function(exports, require) { ${storageCompiled}\n})`, { Date })(storageExports,
      (name) => name === 'expo-file-system' ? fileSystem : exports);
    return storageExports.rememberRecordingStart;
  }
  let remember = loadStorage();
  await Promise.all([remember([new Date('2024-03-01')]), remember([new Date('2024-01-01')])]);
  assert.equal(contents, '2024-01-01T00:00:00.000Z');
  remember = loadStorage();
  assert.equal(await remember([]), contents);
  assert.equal(await remember([new Date('2025-01-01')]), contents);
  failWrite = true;
  await assert.rejects(remember([new Date('2023-01-01')]), /disk full/);
  failWrite = false;
  assert.equal(await remember([new Date('2023-01-01')]), '2023-01-01T00:00:00.000Z');
  contents = 'corrupt';
  await assert.rejects(remember([]), /createdOn/);
});
