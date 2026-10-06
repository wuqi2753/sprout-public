// REQ-055: Execute shortcut, result sorting and right-swipe callbacks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function renderSearch() {
  const compiled = ts.transpileModule(readFileSync(new URL('../../src/components/memo-search.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    react: { useRef: () => ({ current: { measureInWindow: (callback) => callback(0, 100, 48, 48) } }), useState: () => [undefined, () => {}] },
    'react-native': { Keyboard: { dismiss() {} }, Modal: 'Modal', TextInput: 'Input', View: 'View', StyleSheet: { create: (styles) => styles, absoluteFill: {} }, useWindowDimensions: () => ({ height: 792 }) },
    'react-native-svg': { default: 'Svg', Path: 'Path', Rect: 'Rect', Circle: 'Circle' },
    'expo-symbols': { SymbolView: 'Symbol' },
    '@/components/haptic-pressable': { Pressable: 'Button' }, '@/components/themed-text': { ThemedText: 'Text' },
    '@/hooks/use-theme': { useTheme: () => ({}) }, '@/search/memo-search': {},
  };
  const exports = {};
  vm.runInNewContext(`(function(require, exports) { ${compiled}\n})`)((name) => { if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name]; }, exports);
  return exports;
}
function flatten(value) {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!value || typeof value !== 'object') return [];
  return [value, ...flatten(value.props?.children)];
}

test('REQ-055 recent search chips replay keywords and clear history, with no empty section', () => {
  const { MemoRecentSearches } = renderSearch();
  const selected = [];
  let clears = 0;
  assert.equal(MemoRecentSearches({ keywords: [], onSelect() {}, onClear() {} }), null);
  const nodes = flatten(MemoRecentSearches({ keywords: ['工作', '#想法'], onSelect: (keyword) => selected.push(keyword), onClear: () => clears++ }));
  nodes.filter((node) => node.type === 'Button' && node.props.accessibilityLabel.startsWith('搜索 ')).forEach((button) => button.props.onPress());
  assert.deepEqual(selected, ['工作', '#想法']);
  nodes.find((node) => node.props?.accessibilityLabel === '清空最近搜索').props.onPress();
  assert.equal(clears, 1);
});

test('REQ-055 shortcuts provide only no-tag, image and file searches with identical label styling', () => {
  const selected = [];
  const nodes = flatten(renderSearch().MemoSearchShortcuts({ onSelect: (shortcut) => selected.push(shortcut) }));
  const buttons = nodes.filter((node) => node.type === 'Button');
  assert.deepEqual(buttons.map((button) => button.props.accessibilityLabel), ['搜索无标签笔记', '搜索有图片笔记', '搜索有文件笔记']);
  buttons.forEach((button) => button.props.onPress());
  assert.deepEqual(selected, ['untagged', 'images', 'files']);
  const labels = nodes.filter((node) => ['无标签', '有图片', '有文件'].includes(node.props?.children));
  assert.equal(labels.length, 3);
  assert.ok(labels.every((label) => label.props.style === labels[0].props.style));
});

test('REQ-055 result header exposes count and all four sort callbacks without condition-clear controls', () => {
  const orders = [];
  const nodes = flatten(renderSearch().MemoSearchSummary({ count: 3, order: 'created-desc', onOrderChange: (order) => orders.push(order) }));
  const count = nodes.find((node) => Array.isArray(node.props?.children) && node.props.children.join('') === '笔记（3）');
  assert.ok(count);
  assert.equal(nodes.some((node) => /清除|无标签/.test(node.props?.accessibilityLabel ?? '')), false);
  const radios = nodes.filter((node) => node.props?.accessibilityRole === 'radio');
  assert.equal(radios.length, 4);
  radios.forEach((radio) => radio.props.onPress());
  assert.deepEqual(orders, ['created-desc', 'created-asc', 'edited-desc', 'edited-asc']);
});

test('REQ-055 right swipe returns only after the horizontal threshold and is disabled in filter sheet', () => {
  const source = readFileSync(new URL('../../app/index.tsx', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function collect(node) { if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'searchBackGesture') expression = node.initializer.getText(parsed); ts.forEachChild(node, collect); }
  collect(parsed);
  assert.ok(expression);
  const callbacks = {}, settings = {};
  const gesture = new Proxy({}, { get: (_object, name) => (...args) => { if (name.startsWith('on')) callbacks[name] = args[0]; else settings[name] = args[0]; return gesture; } });
  let closes = 0;
  const context = { Gesture: { Pan: () => gesture }, useMemo: (callback) => callback(), scrollGesture: {}, searchVisible: true, searchFiltersOpen: false, closeSearch: () => closes++ };
  const run = () => vm.runInNewContext(ts.transpileModule(expression, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  run(); assert.equal(settings.enabled, true);
  callbacks.onEnd({ translationX: -100 }); callbacks.onEnd({ translationX: 40 }); assert.equal(closes, 0);
  callbacks.onEnd({ translationX: 80 }); assert.equal(closes, 1);
  context.searchFiltersOpen = true; run(); assert.equal(settings.enabled, false);
});
