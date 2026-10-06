// REQ-043: Browser visibility preserves content, timestamps and images.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { recordingStartModules } from '../fixtures/recording-start.mjs';
const searchExports = {};
const searchSource = readFileSync(new URL('../../src/search/memo-search.ts', import.meta.url), 'utf8');
vm.runInNewContext(`(function(exports) { ${ts.transpileModule(searchSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText}\n})`, { Date })(searchExports);
const { matchesMemoSearch, emptySearchFilters, sortSearchMemos } = searchExports;

test('REQ-043 browser hide and restore preserve the memo and reject missing IDs', async () => {
  const source = readFileSync(new URL('../../src/storage/memos.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const modules = {
    ...recordingStartModules(), '@/memos': { extractTags: () => ['private'] }, '@/sync/uuid': { createUuid: () => 'welcome' } };
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`)((name) => {
    if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
    return modules[name];
  }, { exports }, exports);
  await exports.addMemo({ id: 'note', content: 'private', createdOn: new Date(), imageUris: ['photo'] });
  const original = await exports.getMemo('note');
  await exports.setMemoHidden('note', true);
  assert.deepEqual({ ...await exports.getMemo('note') }, { ...original, hidden: true });
  await exports.updateMemoContent('note', 'edited', new Date());
  assert.equal((await exports.getMemo('note')).hidden, true);
  await exports.setMemoHidden('note', false);
  assert.equal((await exports.getMemo('note')).hidden, false);
  await assert.rejects(exports.setMemoHidden('missing', true), /missing memo/);
  await assert.rejects(exports.setMemoHidden('note', 'yes'), /boolean/);
});

test('REQ-043 home search, tags and calendar exclude the other visibility group', () => {
  const source = readFileSync(new URL('../../app/index.tsx', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions = new Map();
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      expressions.set(node.name.text, node.initializer.getText(parsed));
    }
    ts.forEachChild(node, collect);
  }
  collect(parsed);
  const context = vm.createContext({
    memos: [
      { id: 'public', content: 'ordinary', tags: ['public'], createdOn: new Date(2026, 9, 1) },
      { id: 'private', content: 'secret', tags: ['private'], createdOn: new Date(2026, 9, 2), hidden: true },
    ],
    useMemo: (callback) => callback(), visibleYear: 2026, visibleMonth: 9, hiddenMemoAccess: { unlocked: false },
    activeDay: null, activeTag: null, query: '', showingHidden: false,
    searchVisible: false, searchFilters: emptySearchFilters(), matchesMemoSearch, sortSearchMemos, searchSort: 'created-desc',
  });
  function evaluate(name) {
    const compiled = ts.transpileModule(`const result = ${expressions.get(name)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return vm.runInContext(`(() => { ${compiled} return result; })()`, context);
  }
  function refresh() { context.visibleMemos = evaluate('visibleMemos'); }
  refresh();
  assert.deepEqual(Array.from(evaluate('filteredMemos'), (memo) => memo.id), ['public']);
  assert.deepEqual(Array.from(evaluate('tags'), (tag) => tag.name), ['public']);
  assert.deepEqual(Array.from(evaluate('recordDays')), [1]);
  assert.deepEqual(Array.from(evaluate('searchTags')), ['public']);
  context.searchVisible = true;
  context.query = 'secret';
  assert.equal(evaluate('filteredMemos').length, 0);
  context.searchVisible = false;
  context.query = 'secret';
  assert.equal(evaluate('filteredMemos').length, 0);
  context.showingHidden = true;
  context.hiddenMemoAccess.unlocked = true;
  refresh();
  assert.deepEqual(Array.from(evaluate('filteredMemos'), (memo) => memo.id), ['private']);
  assert.deepEqual(Array.from(evaluate('tags'), (tag) => tag.name), ['public']);
  assert.deepEqual(Array.from(evaluate('recordDays')), [2]);
  assert.deepEqual(Array.from(evaluate('searchTags')), ['private']);
  context.activeTag = 'public';
  assert.equal(evaluate('filteredMemos').length, 0);
  const selectTag = parsed.statements.flatMap(function find(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'selectTagAndCloseFilter') return [node];
    return node.getChildren(parsed).flatMap(find);
  })[0];
  context.hiddenMemoSession = { lock: () => { context.showingHidden = false; context.hiddenMemoAccess.unlocked = false; } };
  context.closeSearch = () => { context.query = ''; };
  context.setActiveDay = (day) => { context.activeDay = day; };
  context.setActiveTag = (update) => { context.activeTag = update(context.activeTag); };
  context.setFilterOpen = () => {};
  context.activeTag = null;
  context.activeDay = 2;
  vm.runInContext(ts.transpileModule(selectTag.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  vm.runInContext("selectTagAndCloseFilter('public')", context);
  refresh();
  assert.equal(context.hiddenMemoAccess.unlocked, false);
  assert.equal(context.activeDay, null);
  assert.equal(context.query, '');
  assert.deepEqual(Array.from(evaluate('filteredMemos'), (memo) => memo.id), ['public']);
});
