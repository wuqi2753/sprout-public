// REQ-056: Execute the actual filter sheet callbacks with retained React state.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, modules = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(`(function(require, exports) { ${compiled}\n})`, { Date })((name) => { if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name]; }, exports);
  return exports;
}
const search = load('src/search/memo-search.ts');

function mount(filters = search.emptySearchFilters()) {
  let cursor = 0;
  const states = [];
  const applied = [];
  let cancelled = 0;
  const jsx = (type, props) => ({ type, props });
  const component = load('src/components/memo-search-filters.tsx', {
    react: { useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { Keyboard: { dismiss() {} }, Platform: { OS: 'android' }, Modal: 'Modal', View: 'View', ScrollView: 'Scroll', TextInput: 'Input', KeyboardAvoidingView: 'Keyboard', StyleSheet: { create: (styles) => styles, hairlineWidth: 1, absoluteFill: {} }, useWindowDimensions: () => ({ height: 792 }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 24 }) },
    'expo-symbols': { SymbolView: 'Symbol' },
    'react-native-svg': { default: 'Svg', Path: 'Path' },
    '@/components/haptic-pressable': { Pressable: 'Button' },
    '@/components/themed-text': { ThemedText: 'Text' },
    '@/hooks/use-theme': { useTheme: () => ({}) },
    '@/search/memo-search': search,
  }).MemoSearchFiltersSheet;
  function tree() { cursor = 0; return component({ filters, availableTags: ['阅读', '阅读/书籍', '工作'], onApply: (value) => applied.push(value), onCancel: () => cancelled++ }); }
  function flatten(value) { if (Array.isArray(value)) return value.flatMap(flatten); if (!value || typeof value !== 'object') return []; return [value, ...flatten(value.props?.children)]; }
  function nodes() { return flatten(tree()); }
  function control(label) { const node = nodes().find((node) => node.props?.accessibilityLabel === label); assert.ok(node, `Missing control ${label}`); return node.props; }
  return { applied, cancelled: () => cancelled, control, nodes, tree, press: (label) => control(label).onPress() };
}

test('REQ-056 draft is isolated: cancel keeps applied filters and reset only commits on confirm', () => {
  const original = { ...search.emptySearchFilters(), contentRange: 'images' };
  const cancelled = mount(original);
  cancelled.press('内容范围，有图片'); cancelled.press('有文件');
  assert.equal(original.contentRange, 'images'); assert.equal(cancelled.applied.length, 0);
  cancelled.press('取消筛选修改'); assert.equal(cancelled.cancelled(), 1);
  const sheet = mount(original);
  sheet.press('重置筛选草稿'); assert.equal(sheet.applied.length, 0);
  sheet.press('确定筛选'); assert.equal(search.hasSearchFilters(sheet.applied[0]), false);
});

test('REQ-056 include tags validates, searches, selects and confirms before applying with file range', () => {
  const sheet = mount();
  sheet.press('标签范围，不限标签'); sheet.press('包含指定标签'); sheet.press('确定筛选');
  assert.equal(sheet.applied.length, 0);
  assert.ok(sheet.nodes().some((node) => node.props?.children === '请至少选择一个指定标签。'));
  sheet.press('指定标签，无');
  sheet.control('搜索筛选标签').onChangeText('阅读');
  assert.equal(sheet.nodes().some((node) => node.props?.accessibilityLabel === '选择标签 工作'), false);
  sheet.press('选择标签 阅读'); sheet.press('确定选择');
  assert.ok(sheet.control('指定标签，阅读'));
  sheet.press('内容范围，所有内容'); sheet.press('有文件'); sheet.press('确定筛选');
  assert.equal(sheet.applied[0].tagRange, 'include');
  assert.deepEqual(Array.from(sheet.applied[0].tags), ['阅读']);
  assert.equal(sheet.applied[0].contentRange, 'files');
});

test('REQ-056 system back closes a menu, cancels a tag selection, then cancels the sheet', () => {
  const sheet = mount({ ...search.emptySearchFilters(), tagRange: 'include', tags: ['工作'] });
  sheet.press('内容范围，所有内容'); sheet.tree().props.onRequestClose();
  assert.equal(sheet.cancelled(), 0);
  sheet.press('指定标签，工作'); sheet.press('选择标签 阅读'); sheet.tree().props.onRequestClose();
  assert.ok(sheet.control('指定标签，工作'));
  sheet.tree().props.onRequestClose(); assert.equal(sheet.cancelled(), 1); assert.equal(sheet.applied.length, 0);
});

test('REQ-056 custom dates cannot confirm a reversed range and cancel discards the selection', () => {
  const sheet = mount(); sheet.press('日期范围，不限时间'); sheet.press('自定义');
  sheet.control('开始日期，格式年-月-日').onChangeText('2026-10-10');
  sheet.press('选择结束日期'); sheet.control('结束日期，格式年-月-日').onChangeText('2026-10-01');
  sheet.press('确定选择');
  assert.ok(sheet.nodes().some((node) => node.props?.children === '开始日期不能晚于结束日期。'));
  sheet.press('取消选择'); sheet.press('确定筛选'); assert.equal(sheet.applied[0].dateRange, 'all');
});

test('REQ-056 tag picker shrinks to keyboard viewport while keeping header and confirmation controls', () => {
  const sheet = mount({ ...search.emptySearchFilters(), tagRange: 'include', tags: ['工作'] });
  sheet.press('指定标签，工作');
  sheet.tree().props.children.props.onLayout({ nativeEvent: { layout: { height: 280 } } });
  const surface = sheet.nodes().find((node) => node.type === 'View' && Array.isArray(node.props?.style) && node.props.style[0]?.borderTopLeftRadius === 18);
  assert.ok(surface);
  assert.equal(surface.props.style[1].maxHeight, 244);
  assert.equal(surface.props.style[2].height, 244);
  assert.ok(sheet.control('取消选择'));
  assert.ok(sheet.control('确定选择'));
});
