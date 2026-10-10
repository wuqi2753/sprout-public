// REQ-010: Execute the homepage renderer with native text measurement at its boundary.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function createRenderer(platform = 'android') {
  const source = readFileSync(new URL('../../app/index.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('function MemoContent(');
  const end = source.indexOf('\nfunction MemoImages', start);
  const compiled = ts.transpileModule(`export ${source.slice(start, end)}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const states = [];
  let stateIndex = 0;
  const dimensions = { width: 360, fontScale: 1 };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: () => ({ jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }),
    View: 'View', ThemedText: 'Text', Platform: { OS: platform },
    styles: Object.fromEntries(['memoContent', 'inlineTag', 'inlineTagPill'].map((name) => [name,
      vm.runInNewContext('(' + source.match(new RegExp(`${name}: (\\{[^}]+\\})`))[1] + ')'),
    ])),
    useTheme: () => ({ memoTag: 'orange', memoTagBackground: 'brown' }),
    useWindowDimensions: () => dimensions,
    useState: (initial) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (update) => { states[index] = update(states[index]); }];
    },
  });
  return { render: (props) => { stateIndex = 0; return exports.MemoContent(props); }, dimensions };
}

function textContent(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (node.props.importantForAccessibility === "no-hide-descendants") return "";
  return textContent(node.props.children);
}

test('REQ-010 retains newlines, blank lines, whitespace, tags and long mixed text', () => {
  const { render } = createRenderer();
  for (const content of ['第一行\n第二行\n\n第四行', '#标签 中文 English\n下一行 #tag', 'one\r\ntwo\rthree', '  缩进\tspace  ', 'supercalifragilisticexpialidocious'.repeat(8), '1\n2\n3\n4\n5\n6\n7\n']) {
    const tree = render({ content, numberOfLines: 6, onOverflowChange: () => {} });
    assert.equal(textContent(tree), content.replace(/\r\n?/g, '\n'));
  }
});

test('REQ-010 retains rounded inline tags with measured width without duplicating visible text', () => {
  const { render } = createRenderer();
  const props = { content: '#标签 正文\n第二行', numberOfLines: 6, onOverflowChange: () => {} };
  const initial = render(props);
  initial.props.children[0].props.children[0].props.onLayout({ nativeEvent: { layout: { width: 37.5 } } });
  const tree = render(props);
  const tag = tree.props.children[1].props.children.find((segment) => typeof segment === 'object');
  assert.equal(tag.type, 'View');
  assert.equal(tag.props.style[0].borderRadius, 6);
  assert.equal(tag.props.style[0].paddingHorizontal, 4);
  assert.equal(tag.props.style[0].paddingVertical, 1);
  assert.equal(tag.props.children.props.style[0].fontSize, 12);
  assert.equal(tag.props.children.props.style[0].lineHeight, 15);
  assert.equal(tag.props.children.props.style[0].fontWeight, '400');
  assert.equal(tag.props.style[1].backgroundColor, 'brown');
  assert.equal(tag.props.children.props.style[1].color, 'orange');
  assert.equal(tag.props.style[1].width, 46);
  assert.equal(tag.props.style[1].height, 17);
  assert.equal(tag.props.style[1].transform[0].translateY, 2.5);
  assert.equal(tree.props.children[1].props.style[1].lineHeight, 27);
  assert.equal(tree.props.children[1].props.style[0].fontSize, 16);
  assert.equal(tree.props.children[1].props.style[0].fontWeight, '400');
  assert.equal(textContent(tree), props.content);
});

test('REQ-010 measures Web overflow without relying on unsupported onTextLayout', () => {
  const { render } = createRenderer('web');
  const overflow = [];
  const props = { content: '1\n2\n3\n4\n5\n6\n7', numberOfLines: 6, onOverflowChange: (value) => overflow.push(value) };
  render(props).props.children[1].props.onLayout({ nativeEvent: { layout: { height: 168 } } });
  assert.equal(overflow.at(-1), true);
  assert.equal(render(props).props.style.maxHeight, 162);
  render(props).props.children[1].props.onLayout({ nativeEvent: { layout: { height: 144 } } });
  assert.equal(overflow.at(-1), false);
});

test('REQ-010 clips exactly at the sixth measured line and expands without clipping', () => {
  const { render, dimensions } = createRenderer();
  const overflow = [];
  const props = { content: '1\n2\n3\n4\n5\n6\n7', numberOfLines: 6, onOverflowChange: (value) => overflow.push(value) };
  const lines = Array.from({ length: 7 }, (_, index) => ({ y: index * 31, height: 29 }));
  render(props).props.children[1].props.onTextLayout({ nativeEvent: { lines } });
  assert.equal(render(props).props.style.maxHeight, 184);
  assert.equal(overflow.at(-1), true);
  assert.equal(render({ ...props, numberOfLines: undefined }).props.style, undefined);
  render(props).props.children[1].props.onTextLayout({ nativeEvent: { lines: lines.slice(0, 6) } });
  assert.equal(overflow.at(-1), false);
  dimensions.fontScale = 1.5;
  assert.equal(render(props).props.style.maxHeight, 234);
  dimensions.width = 320;
  render(props).props.children[1].props.onTextLayout({ nativeEvent: { lines: [{ y: 0, height: 36 }] } });
  assert.equal(overflow.at(-1), false);
  assert.equal(textContent(render({ ...props, content: '新正文\n新段落' })), '新正文\n新段落');
});

test('REQ-010 centers rounded tags using native font metrics and retains the 3dp row gap at larger font scale', () => {
  const { render, dimensions } = createRenderer();
  const props = { content: '#tag 中文\n第二行', numberOfLines: 6, onOverflowChange: () => {} };
  render(props).props.children[1].props.onTextLayout({ nativeEvent: { lines: [{ y: 0, height: 27, capHeight: 11 }] } });
  let tree = render(props);
  let tag = tree.props.children[1].props.children.find((segment) => typeof segment === 'object');
  assert.equal(tag.props.style[1].transform[0].translateY, 3);
  dimensions.fontScale = 1.5;
  tree = render(props);
  tag = tree.props.children[1].props.children.find((segment) => typeof segment === 'object');
  assert.equal(tree.props.children[1].props.style[1].lineHeight * dimensions.fontScale, 39);
  assert.equal(tag.props.style[1].height, 24.5);
  assert.equal(tag.props.style[0].borderRadius, 6);
  assert.equal(textContent(tree), props.content);
});
