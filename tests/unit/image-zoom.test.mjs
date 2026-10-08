// REQ-071: exercise zoom limits and pan bounds for landscape/portrait images.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/components/image-zoom.ts', import.meta.url), 'utf8');
const exports = {};
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(`(function(exports) { ${compiled}\n})`)(exports);

test('REQ-071 pinch scale stays between original fit and four times fit', () => {
  for (const [input, expected] of [[0.2, 1], [1, 1], [2.5, 2.5], [4, 4], [8, 4]]) {
    assert.equal(exports.clampImageScale(input), expected);
  }
});

test('REQ-071 dragging respects the actual contained image and resets at original fit', () => {
  const clamp = exports.clampImageOffset;
  assert.equal(clamp(200, 360, 360, 2), 180);
  assert.equal(clamp(-200, 360, 360, 2), -180);
  assert.equal(clamp(50, 180, 800, 2), 0);
  assert.equal(clamp(50, 360, 360, 1), 0);
  assert.equal(clamp(50, 180, 800, 1), 0);
  assert.equal(clamp(35, 360, 360, 2), 35);
});
