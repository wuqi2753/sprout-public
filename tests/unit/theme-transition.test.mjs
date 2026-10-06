// REQ-046 / REQ-060: Execute theme switching and startup restoration with mocked native boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function createProvider({ reducedMotion = false, failSave = false, capture, savedPreference = 'light', systemScheme = 'light', readPreference } = {}) {
  const states = [], refs = [], effects = [], animations = [], captures = [], saves = [];
  let stateIndex = 0, refIndex = 0, firstRender = true, subscriber;
  const shared = { get: () => 0, set: () => {} };
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    useContext: () => undefined,
    useState: (initial) => {
      const index = stateIndex++;
      if (firstRender) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value) => {
        states[index] = value;
        if (value?.uri) setImmediate(() => {
          const rendered = render();
          rendered.props.children.props.children[1]?.props.children[0].props.onLoad();
        });
      }];
    },
    useRef: (initial) => {
      const index = refIndex++;
      if (!refs[index]) refs[index] = { current: initial === null ? { measureInWindow: (callback) => callback(0, 0) } : initial };
      return refs[index];
    },
    useEffect: (effect) => { if (firstRender) effects.push(effect); },
  };
  const dependencies = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { AccessibilityInfo: { isReduceMotionEnabled: async () => reducedMotion }, Image: { prefetch: async () => true }, Platform: { OS: 'android' }, StyleSheet: { absoluteFill: {} }, View: 'view', useColorScheme: () => systemScheme, useWindowDimensions: () => ({ width: 375, height: 812 }) },
    'react-native-reanimated': { __esModule: true, default: { createAnimatedComponent: (component) => component }, cancelAnimation: () => {}, Easing: { inOut: () => 'ease', quad: 'quad' }, runOnJS: (fn) => fn, useAnimatedProps: (fn) => fn(), useSharedValue: () => shared, withTiming: (radius, options, callback) => { animations.push({ radius, ...options }); callback(true); return radius; } },
    'react-native-svg': { __esModule: true, default: 'svg', Circle: 'circle', Defs: 'defs', Image: 'image', Mask: 'mask', Rect: 'rect' },
    'react-native-view-shot': { captureRef: async (_ref, options) => { captures.push(options); return capture ? capture() : 'data:image/png;base64,old'; } },
    '@/components/feedback-dialog': { FeedbackDialog: 'FeedbackDialog' },
    '@/constants/theme': { Colors: { light: { background: 'white' }, dark: { background: 'black' } } },
    '@/auth/hidden-memo-session': { hiddenMemoSession: { subscribe: (callback) => { subscriber = callback; return () => {}; }, getSnapshot: () => ({ unlocked: false }) } },
    '@/storage/theme-preference': { getThemePreference: async () => readPreference ? readPreference() : savedPreference, saveThemePreference: async (mode) => { if (failSave) throw new Error('Storage failed'); saves.push(mode); } },
  };
  const source = readFileSync(new URL('../../src/components/app-theme-provider.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(require, exports) { ${compiled}\n})`, { console: { error: () => {} }, setTimeout, clearTimeout, requestAnimationFrame: (callback) => callback() })((name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, exports);
  function render() {
    stateIndex = 0; refIndex = 0;
    const rendered = exports.AppThemeProvider({ children: 'content' });
    firstRender = false;
    return rendered;
  }
  render();
  effects.forEach((effect) => effect());
  await new Promise((resolve) => setImmediate(resolve));
  return { render, captures, saves, animations, get alerts() {
    const dialog = render().props.children.props.children.find((child) => child?.type === 'FeedbackDialog');
    return dialog.props.visible ? [[dialog.props.title, dialog.props.message]] : [];
  }, lock: () => subscriber() };
}

test('REQ-046 circular reveal lasts 400ms, covers the farthest corner and releases snapshot', async () => {
  const provider = await createProvider();
  await provider.render().props.value.selectTheme('dark', { x: 24, y: 780 });
  assert.equal(provider.captures[0].result, 'data-uri');
  assert.deepEqual(provider.saves, ['dark']);
  assert.equal(provider.animations[0].duration, 400);
  assert.ok(provider.animations[0].radius >= Math.hypot(375 - 24, 780));
  const rendered = provider.render();
  assert.equal(rendered.props.value.colorScheme, 'dark');
  assert.equal(rendered.props.value.changing, false);
  assert.equal(rendered.props.children.props.children[1], undefined);
});

for (const systemScheme of ['light', 'dark']) {
  test(`REQ-060 no preference defaults to dark with ${systemScheme} system and does not save`, async () => {
    const provider = await createProvider({ systemScheme, readPreference: async () => undefined });
    assert.equal(provider.render().props.value.colorScheme, 'dark');
    assert.equal(provider.render().props.value.ready, true);
    assert.deepEqual(provider.saves, []);
  });
  for (const savedPreference of ['light', 'dark']) {
    test(`REQ-060 restores saved ${savedPreference} with ${systemScheme} system`, async () => {
      const provider = await createProvider({ systemScheme, savedPreference });
      assert.equal(provider.render().props.value.colorScheme, savedPreference);
      assert.deepEqual(provider.saves, []);
    });
  }
}

test('REQ-060 waits for preference read, then restores light without writing a default', async () => {
  let finishRead;
  const provider = await createProvider({ readPreference: () => new Promise((resolve) => { finishRead = resolve; }) });
  assert.equal(provider.render().props.value.ready, false);
  finishRead('light');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.render().props.value.ready, true);
  assert.equal(provider.render().props.value.colorScheme, 'light');
  assert.deepEqual(provider.saves, []);
});

test('REQ-060 failed preference read reports failure and falls back to dark without writing', async () => {
  const provider = await createProvider({ readPreference: async () => { throw new Error('Storage unavailable'); } });
  assert.equal(provider.render().props.value.ready, true);
  assert.equal(provider.render().props.value.colorScheme, 'dark');
  assert.equal(provider.alerts.length, 1);
  assert.match(provider.alerts[0][1], /深色/);
  assert.deepEqual(provider.saves, []);
});

test('REQ-046 reduced motion switches without capturing or animating', async () => {
  const provider = await createProvider({ reducedMotion: true });
  await provider.render().props.value.selectTheme('dark');
  assert.equal(provider.render().props.value.colorScheme, 'dark');
  assert.equal(provider.captures.length, 0);
  assert.equal(provider.animations.length, 0);
});

test('REQ-046 failed save retains theme, clears snapshot and reports failure', async () => {
  const provider = await createProvider({ failSave: true });
  await provider.render().props.value.selectTheme('dark');
  const rendered = provider.render();
  assert.equal(rendered.props.value.colorScheme, 'light');
  assert.equal(rendered.props.children.props.children[1], undefined);
  assert.equal(provider.alerts.length, 1);
});

test('REQ-046 lock cancels pending capture and duplicate click cannot start another transition', async () => {
  let completeCapture;
  const provider = await createProvider({ capture: () => new Promise((resolve) => { completeCapture = resolve; }) });
  const context = provider.render().props.value;
  const pending = context.selectTheme('dark');
  await new Promise((resolve) => setImmediate(resolve));
  await context.selectTheme('dark');
  assert.equal(provider.captures.length, 1);
  provider.lock();
  completeCapture('data:image/png;base64,private');
  await pending;
  assert.equal(provider.saves.length, 0);
  assert.equal(provider.animations.length, 0);
  assert.equal(provider.render().props.children.props.children[1], undefined);
});
