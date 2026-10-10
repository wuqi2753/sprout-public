// REQ-095: exercise the actual component's lifecycle, gestures and animation callbacks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../../src/components/swipe-sidebar.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;

function mountSidebar(initialOpen) {
  const slots = [], effects = [], listeners = new Map();
  let cursor = 0, props = { open: initialOpen, width: 300, gesturesEnabled: true };
  let tree, pan;
  const react = {
    createElement: (type, attributes, ...children) => ({ type, ...attributes, children }),
    useRef: (value) => { const index = cursor++; return slots[index] ??= { current: value }; },
    useState: (value) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = value;
      return [slots[index], (next) => { slots[index] = next; }];
    },
    useEffect: (callback, dependencies) => {
      const index = cursor++;
      if (!slots[index] || dependencies.some((value, i) => value !== slots[index].dependencies[i])) {
        effects.push(() => {
          slots[index]?.cleanup?.();
          slots[index] = { dependencies, cleanup: callback() };
        });
      }
    },
  };
  const appState = {
    currentState: 'active',
    addEventListener: (event, callback) => {
      listeners.set(event, callback);
      return { remove: () => listeners.delete(event) };
    },
  };
  react.useLayoutEffect = react.useEffect;
  const animated = {
    useSharedValue: (value) => {
      const ref = react.useRef();
      return ref.current ??= {
        value, animation: undefined,
        get() { throw new Error('Synchronous UI read on JS'); },
        set(next) {
          if (next?.animation) this.animation = next;
          else { this.value = next; this.animation = undefined; }
        },
      };
    },
    withSpring: (destination, config, callback) => ({ animation: true, destination, callback }),
    cancelAnimation: (value) => { value.animation = undefined; },
    runOnUI: (callback) => callback,
    useAnimatedStyle: (callback) => callback(),
    default: { View: 'AnimatedView' },
  };
  const modules = {
    react,
    'react-native': {
      AppState: appState,
      BackHandler: { addEventListener: (event, callback) => { listeners.set(event, callback); return { remove: () => listeners.delete(event) }; } },
      Keyboard: { dismiss() {} }, Pressable: 'Pressable', View: 'View',
      StyleSheet: { create: (styles) => styles, absoluteFill: {} },
    },
    'react-native-reanimated': animated,
    'react-native-worklets': { scheduleOnRN: (callback, ...args) => callback(...args) },
    'react-native-gesture-handler': {
      GestureDetector: 'GestureDetector',
      Gesture: { Pan: () => {
        pan = { callbacks: {} };
        for (const name of ['enabled', 'activeOffsetX', 'failOffsetY', 'onBegin', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
          pan[name] = (value) => { pan.callbacks[name] = value; return pan; };
        }
        return pan;
      } },
    },
  };
  const exports = {};
  vm.runInNewContext(`(function(require,exports){${compiled}\n})`, { React: react })(name => modules[name], exports);
  function render() {
    cursor = 0;
    tree = exports.SwipeSidebar({ ...props, onOpenChange: (open) => { props = { ...props, open }; }, onEdgeBack() {} });
    while (effects.length) effects.shift()();
  }
  render();
  const overlay = () => tree.children[0].children[1];
  return {
    render,
    offset: slots[0].current,
    setOpen(open) { props = { ...props, open }; render(); render(); },
    lifecycle(state) { appState.currentState = state; listeners.get('change')(state); render(); },
    drag() {
      pan.callbacks.onBegin({ absoluteX: 100 });
      pan.callbacks.onStart();
      pan.callbacks.onUpdate({ translationX: -100 });
      render();
    },
    finalize() { pan.callbacks.onFinalize(); render(); },
    swipeClosed() {
      pan.callbacks.onBegin({ absoluteX: 100 }); pan.callbacks.onStart();
      pan.callbacks.onUpdate({ translationX: -250 });
      pan.callbacks.onEnd({ translationX: -250, velocityX: -600 });
      pan.callbacks.onFinalize(); render();
    },
    close() { overlay().children[0].children[0].onPress(); render(); },
    back() { assert.equal(listeners.get('hardwareBackPress')(), true); render(); },
    finish() { const pending = slots[0].current.animation; if (pending) { slots[0].current.value = pending.destination; pending.callback(true); } render(); },
    visible: () => overlay().pointerEvents === 'auto',
    gesturesEnabled: () => pan.callbacks.enabled,
  };
}

test('REQ-095 open sidebar survives background and closes by backdrop or Android back', () => {
  for (const closeMethod of ['close', 'back']) {
    const sidebar = mountSidebar(true);
    sidebar.lifecycle('background');
    assert.equal(sidebar.gesturesEnabled(), false);
    sidebar.lifecycle('active');
    assert.equal(sidebar.offset.value, 300);
    assert.equal(sidebar.visible(), true);
    sidebar[closeMethod](); sidebar.finish();
    assert.equal(sidebar.visible(), false);
    sidebar.setOpen(true);
    assert.equal(sidebar.visible(), true);
  }
});

test('REQ-095 interrupted opening and closing settle to confirmed state', () => {
  for (const nextOpen of [true, false]) {
    const sidebar = mountSidebar(!nextOpen);
    sidebar.setOpen(nextOpen);
    assert.ok(sidebar.offset.animation);
    sidebar.lifecycle('inactive'); sidebar.lifecycle('background'); sidebar.lifecycle('active');
    assert.equal(sidebar.offset.animation, undefined);
    assert.equal(sidebar.offset.value, nextOpen ? 300 : 0);
    assert.equal(sidebar.visible(), nextOpen);
    assert.equal(sidebar.gesturesEnabled(), true);
  }
});

test('REQ-095 interrupted drag resets even if native finalization arrives after resume', () => {
  const sidebar = mountSidebar(true);
  sidebar.drag(); assert.equal(sidebar.offset.value, 200);
  sidebar.lifecycle('background'); sidebar.lifecycle('active'); sidebar.finalize();
  assert.equal(sidebar.offset.value, 300);
  assert.equal(sidebar.offset.animation, undefined);
  sidebar.close(); sidebar.finish(); assert.equal(sidebar.visible(), false);
});

test('REQ-095 stale close completion cannot hide reopened sidebar', () => {
  const sidebar = mountSidebar(true);
  sidebar.close(); const oldCompletion = sidebar.offset.animation.callback;
  sidebar.setOpen(true); oldCompletion(true); sidebar.render();
  assert.equal(sidebar.visible(), true);
});

test('REQ-095 left swipe remains available after repeated background cycles', () => {
  const sidebar = mountSidebar(true);
  for (let cycle = 0; cycle < 3; cycle++) {
    sidebar.lifecycle('background'); sidebar.lifecycle('active');
    sidebar.swipeClosed(); sidebar.finish();
    assert.equal(sidebar.visible(), false);
    sidebar.setOpen(true); sidebar.finish();
    assert.equal(sidebar.visible(), true);
  }
});
