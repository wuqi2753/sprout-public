// REQ-055 / REQ-056: Search behavior, attachment combinations and local date boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/search/memo-search.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const search = {};
vm.runInNewContext(`(function(exports) { ${compiled}\n})`, { Date })(search);
const memo = (overrides = {}) => ({ content: '在地铁记录 BOOK 想法', tags: ['阅读/书籍'], imageUris: [], fileAttachments: [], createdOn: new Date(2026, 9, 5, 12), ...overrides });
const filters = (overrides = {}) => ({ ...search.emptySearchFilters(), ...overrides });

test('REQ-055 search matches all whitespace-separated words and tags, ignoring case', () => {
  assert.equal(search.matchesMemoSearch(memo(), ' book  想法\n#阅读 ', filters()), true);
  assert.equal(search.matchesMemoSearch(memo(), 'book 缺少', filters()), false);
  assert.equal(search.matchesMemoSearch(memo({ content: '正文没有标签' }), '书籍', filters()), true);
  assert.equal(search.matchesMemoSearch(memo(), '   ', filters()), true);
});

test('REQ-055 / REQ-056 no-tag, image and file ranges treat mixed and file-only notes correctly', () => {
  const mixed = memo({ imageUris: ['image'], fileAttachments: [{ id: 'file' }] });
  assert.equal(search.matchesMemoSearch(mixed, '', filters({ contentRange: 'images' })), true);
  assert.equal(search.matchesMemoSearch(mixed, '', filters({ contentRange: 'files' })), true);
  assert.equal(search.matchesMemoSearch(memo({ fileAttachments: [{ id: 'file' }] }), '', filters({ contentRange: 'images' })), false);
  assert.equal(search.matchesMemoSearch(memo({ imageUris: ['image'] }), '', filters({ contentRange: 'files' })), false);
  assert.equal(search.matchesMemoSearch(mixed, '', filters({ tagRange: 'untagged' })), false);
  assert.equal(search.matchesMemoSearch(memo({ tags: [] }), '', filters({ tagRange: 'untagged' })), true);
});

test('REQ-056 tag include/exclude matches any selected tag and its descendants with a slash boundary', () => {
  assert.equal(search.matchesMemoSearch(memo(), '', filters({ tagRange: 'include', tags: ['工作', '阅读'] })), true);
  assert.equal(search.matchesMemoSearch(memo(), '', filters({ tagRange: 'exclude', tags: ['阅读'] })), false);
  assert.equal(search.matchesMemoSearch(memo({ tags: ['阅读笔记'] }), '', filters({ tagRange: 'include', tags: ['阅读'] })), false);
  assert.equal(search.matchesMemoSearch(memo({ tags: [] }), '', filters({ tagRange: 'exclude', tags: ['阅读'] })), true);
  assert.match(search.searchFilterError(filters({ tagRange: 'include' })), /至少选择/);
  assert.throws(() => search.matchesMemoSearch(memo(), '', filters({ tagRange: 'exclude' })), /至少选择/);
});

test('REQ-056 custom dates include local end-of-day and reject invalid/missing/reversed dates', () => {
  const range = filters({ dateRange: 'custom', startDate: '2026-10-01', endDate: '2026-10-05' });
  for (const date of [new Date(2026, 9, 1), new Date(2026, 9, 5, 23, 59, 59, 999)]) assert.equal(search.matchesMemoSearch(memo({ createdOn: date }), '', range), true);
  for (const date of [new Date(2026, 8, 30, 23, 59, 59), new Date(2026, 9, 6)]) assert.equal(search.matchesMemoSearch(memo({ createdOn: date }), '', range), false);
  assert.match(search.searchFilterError({ ...range, startDate: '2026-02-30' }), /有效/);
  assert.match(search.searchFilterError({ ...range, endDate: '' }), /有效/);
  assert.match(search.searchFilterError({ ...range, startDate: '2026-10-06' }), /不能晚于/);
  assert.equal(search.searchFilterError({ ...range, startDate: '2024-02-29' }), undefined);
});

test('REQ-056 this week starts Monday including Sunday; this month handles year transitions', () => {
  const sunday = new Date(2026, 9, 11, 12);
  const week = filters({ dateRange: 'week' });
  assert.equal(search.matchesMemoSearch(memo({ createdOn: new Date(2026, 9, 5) }), '', week, sunday), true);
  assert.equal(search.matchesMemoSearch(memo({ createdOn: new Date(2026, 9, 11, 23, 59, 59) }), '', week, sunday), true);
  assert.equal(search.matchesMemoSearch(memo({ createdOn: new Date(2026, 9, 4, 23, 59, 59) }), '', week, sunday), false);
  assert.equal(search.matchesMemoSearch(memo({ createdOn: new Date(2026, 9, 12) }), '', week, sunday), false);
  const december = new Date(2026, 11, 20);
  assert.equal(search.matchesMemoSearch(memo({ createdOn: new Date(2026, 11, 31, 23, 59, 59) }), '', filters({ dateRange: 'month' }), december), true);
  assert.equal(search.matchesMemoSearch(memo({ createdOn: new Date(2027, 0, 1) }), '', filters({ dateRange: 'month' }), december), false);
});

test('REQ-056 filters and keyword intersect, default ranges have no active condition', () => {
  const combined = filters({ dateRange: 'month', tagRange: 'include', tags: ['阅读'], contentRange: 'files' });
  assert.equal(search.matchesMemoSearch(memo({ fileAttachments: [{ id: 'file' }] }), 'book', combined, new Date(2026, 9, 5)), true);
  assert.equal(search.matchesMemoSearch(memo(), 'book', combined, new Date(2026, 9, 5)), false);
  assert.equal(search.hasSearchFilters(filters()), false);
  assert.equal(search.hasSearchFilters(combined), true);
});

test('REQ-055 all four result sort orders use creation/edit timestamps without mutating source notes', () => {
  const notes = [
    memo({ id: 'older', createdOn: new Date(2026, 9, 1), savedAt: new Date(2026, 9, 6) }),
    memo({ id: 'newer', createdOn: new Date(2026, 9, 5), savedAt: new Date(2026, 9, 5) }),
  ];
  const ids = (order) => Array.from(search.sortSearchMemos(notes, order), (note) => note.id);
  assert.deepEqual(ids('created-desc'), ['newer', 'older']);
  assert.deepEqual(ids('created-asc'), ['older', 'newer']);
  assert.deepEqual(ids('edited-desc'), ['older', 'newer']);
  assert.deepEqual(ids('edited-asc'), ['newer', 'older']);
  assert.deepEqual(notes.map((note) => note.id), ['older', 'newer']);
});
