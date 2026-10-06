// REQ-046: Persist theme choice, reject corrupt values and surface write failures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadPreference(native, saved, failWrites = false) {
  const source = readFileSync(new URL(`../../src/storage/theme-preference${native ? '.native' : ''}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const read = (key) => saved.get(key) ?? null;
  const write = (key, value) => {
    if (failWrites) throw new Error('Storage unavailable');
    saved.set(key, value);
  };
  const exports = {};
  vm.runInNewContext(`(function(require, exports) { ${compiled}\n})`, { window: { localStorage: { getItem: read, setItem: write } } })((name) => {
    if (name !== 'expo-secure-store') throw new Error(`Unexpected import: ${name}`);
    return { getItemAsync: async (key) => read(key), setItemAsync: async (key, value) => write(key, value) };
  }, exports);
  return exports;
}

for (const native of [false, true]) {
  test(`REQ-046 ${native ? 'native' : 'web'} theme persists across reload and rejects invalid storage`, async () => {
    const saved = new Map();
    const storage = loadPreference(native, saved);
    assert.equal(await storage.getThemePreference(), undefined);
    for (const mode of ['dark', 'light']) {
      await storage.saveThemePreference(mode);
      assert.equal(await loadPreference(native, saved).getThemePreference(), mode);
    }
    await assert.rejects(storage.saveThemePreference('invalid'), /light or dark/);
    saved.set('sprout.theme-preference', 'invalid');
    await assert.rejects(storage.getThemePreference(), /light or dark/);
  });
  test(`REQ-046 ${native ? 'native' : 'web'} failed write preserves saved theme`, async () => {
    const saved = new Map([['sprout.theme-preference', 'light']]);
    await assert.rejects(loadPreference(native, saved, true).saveThemePreference('dark'), /Storage unavailable/);
    assert.equal(await loadPreference(native, saved).getThemePreference(), 'light');
  });
}
