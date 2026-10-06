// REQ-047: Native transition must reopen an already focused Android input.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('REQ-047 keyboard opens after entry, ignores closing, and cleans scheduled work', () => {
  const source = readFileSync(new URL('../../app/memo/[id].tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  // REQ-047: Open the IME');
  const end = source.indexOf('\n  useEffect(', source.indexOf('}, [navigation, memo?.id, hiddenMemoLocked]);', start));
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const locked of [false, true]) {
    const calls = []; let transition, timer, cleanup;
    const context = {
      memo: { id: 'note' }, hiddenMemoLocked: locked, activeRef: { current: true },
      inputRef: { current: { blur: () => calls.push('blur'), focus: () => calls.push('focus') } },
      navigation: { isFocused: () => true, addListener: (_, callback) => { transition = callback; return () => calls.push('unsubscribe'); } },
      useEffect: (callback) => { cleanup = callback(); },
      setTimeout: (callback) => { timer = callback; return 1; }, clearTimeout: () => calls.push('clearTimer'),
      requestAnimationFrame: (callback) => { callback(); return 2; }, cancelAnimationFrame: () => calls.push('clearFrame'),
    };
    vm.runInNewContext(compiled, context);
    if (locked) { assert.equal(transition, undefined); continue; }
    transition({ data: { closing: true } }); assert.deepEqual(calls, []);
    transition({ data: { closing: false } }); assert.deepEqual(calls, ['clearTimer', 'blur', 'focus']);
    context.activeRef.current = false; timer(); assert.equal(calls.filter((name) => name === 'focus').length, 1);
    cleanup(); assert.ok(calls.includes('unsubscribe')); assert.ok(calls.includes('clearFrame'));
  }
});

test('REQ-047 shared tag query recognizes cursor token and excludes completed or unrelated tokens', () => {
  const source = readFileSync(new URL('../../src/memos.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports });
  assert.equal(exports.findTagDraft('正文 #', 5).query, '');
  const draft = exports.findTagDraft('正文 #开 后文', 5);
  assert.equal(draft.query, '开');
  assert.equal(`正文 #开 后文`.slice(0, draft.start) + '#开心 ' + `正文 #开 后文`.slice(draft.end), '正文 #开心  后文');
  assert.equal(exports.findTagDraft('正文 #开心 ', 7), null);
  assert.equal(exports.findTagDraft('正文 #开心', 2), null);
});
