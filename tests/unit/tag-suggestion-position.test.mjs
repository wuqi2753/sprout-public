// REQ-054: verify caret-relative placement at viewport and keyboard boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/components/tag-suggestion-position.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(`(function(exports) { ${compiled}\n})`)(exports);
const position = exports.positionTagSuggestions;

test('REQ-054 follows the current line and clamps horizontally to the editor', () => {
  const first = position({ caretX: 40, lineTop: 10, lineBottom: 34, width: 375, height: 400, count: 5 });
  assert.equal(first.top, 42);
  assert.equal(first.left, 40);
  const moved = position({ caretX: 360, lineTop: 60, lineBottom: 84, width: 375, height: 400, count: 5 });
  assert.equal(moved.top, 92);
  assert.equal(moved.left + moved.width, 367);
});

test('REQ-054 flips above the caret near the keyboard and allows a shorter scrollable list', () => {
  const above = position({ caretX: 30, lineTop: 250, lineBottom: 274, width: 375, height: 300, count: 5 });
  assert.equal(above.top + above.height, 242);
  const compact = position({ caretX: 20, lineTop: 70, lineBottom: 94, width: 200, height: 120, count: 5 });
  assert.equal(compact.height, 54);
  assert.equal(compact.width, 184);
  assert.ok(compact.top >= 8 && compact.top + compact.height <= 120);
});

test('REQ-054 shows all three homepage tags above the composer instead of clipping to one row', () => {
  const popup = position({ caretX: 40, lineTop: 235, lineBottom: 290, width: 360, height: 340, count: 3, forceAbove: true });
  assert.equal(popup.height, 144);
  assert.equal(popup.top + popup.height, 227);
  assert.equal(popup.left, 8);
  assert.equal(popup.width, 344);
  assert.ok(popup.top >= 0);
});

test('REQ-054 hides empty, offscreen or too-short suggestions instead of covering the caret', () => {
  const frame = { caretX: 20, lineTop: 10, lineBottom: 34, width: 375, height: 400, count: 5 };
  assert.equal(position({ ...frame, count: 0 }), undefined);
  assert.equal(position({ ...frame, lineTop: 420, lineBottom: 444 }), undefined);
  assert.equal(position({ ...frame, lineTop: -100, lineBottom: -76 }), undefined);
  assert.equal(position({ ...frame, height: 60 }), undefined);
});
