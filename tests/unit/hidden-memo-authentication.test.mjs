// REQ-044: Real session logic and SDK boundary, including asynchronous stale results.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(filename, modules) {
  const source = readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})`, { requestAnimationFrame: (callback) => callback(), cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {} })((name) => {
    if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
    const exported = modules[name];
    if (exported instanceof Error) throw exported;
    return exported;
  }, { exports }, exports);
  return exports;
}

function createSession(authenticate) {
  return load('src/auth/hidden-memo-session.ts', { './biometric-authentication': { authenticateHiddenMemos: authenticate } }).createHiddenMemoSession(authenticate);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('session unlock is volatile, updates subscribers, and relocks on inactive/background', async () => {
  const session = createSession(async () => ({ success: true }));
  let updates = 0;
  const unsubscribe = session.subscribe(() => { updates += 1; });
  assert.equal(session.getSnapshot().unlocked, false);
  assert.equal((await session.unlock()).success, true);
  assert.equal(session.getSnapshot().unlocked, true);
  assert.equal(session.getSnapshot().authenticating, false);
  session.setAppState('inactive');
  assert.equal(session.getSnapshot().unlocked, false);
  session.setAppState('active');
  assert.equal(session.getSnapshot().unlocked, false);
  await session.unlock();
  session.setAppState('background');
  assert.equal(session.getSnapshot().unlocked, false);
  assert.equal((await session.unlock()).success, false);
  assert.equal(createSession(async () => ({ success: true })).getSnapshot().unlocked, false);
  assert.ok(updates >= 6);
  unsubscribe();
  const previousUpdates = updates;
  session.setAppState('active');
  await session.unlock();
  assert.equal(updates, previousUpdates);
});

for (const outcome of [{ success: false, cancelled: true }, { success: false, cancelled: false, message: 'locked' }]) {
  test(`verification failure never unlocks (cancelled=${outcome.cancelled})`, async () => {
    const session = createSession(async () => outcome);
    assert.equal(await session.unlock(), outcome);
    assert.equal(session.getSnapshot().unlocked, false);
    assert.equal(session.getSnapshot().authenticating, false);
  });
}

test('rapid taps invoke only one prompt and prompt-induced inactive does not invalidate success', async () => {
  const attempt = deferred();
  let calls = 0;
  const session = createSession(() => { calls += 1; return attempt.promise; });
  const first = session.unlock();
  assert.equal(session.getSnapshot().authenticating, true);
  assert.equal((await session.unlock()).success, false);
  session.setAppState('inactive');
  session.setAppState('active');
  attempt.resolve({ success: true });
  assert.equal((await first).success, true);
  assert.equal(calls, 1);
  assert.equal(session.getSnapshot().unlocked, true);
});

for (const reason of ['background', 'leave']) {
  test(`a late success cannot unlock after ${reason}`, async () => {
    const attempt = deferred();
    const session = createSession(() => attempt.promise);
    const pending = session.unlock();
    if (reason === 'background') { session.setAppState('background'); session.setAppState('active'); }
    else session.lock();
    attempt.resolve({ success: true });
    assert.equal((await pending).success, false);
    assert.equal(session.getSnapshot().unlocked, false);
    assert.equal(session.getSnapshot().authenticating, false);
  });
}

test('unexpected SDK exceptions reset busy state and permit a retry', async () => {
  let calls = 0;
  const session = createSession(async () => {
    if (++calls === 1) throw new Error('SDK failed');
    return { success: true };
  });
  await assert.rejects(session.unlock(), /SDK failed/);
  assert.equal(session.getSnapshot().unlocked, false);
  assert.equal(session.getSnapshot().authenticating, false);
  assert.equal((await session.unlock()).success, true);
});

function nativeAuthentication(overrides = {}, platform = 'android') {
  let prompts = 0;
  let options;
  const sdk = {
    hasHardwareAsync: async () => true,
    isEnrolledAsync: async () => true,
    getEnrolledLevelAsync: async () => 3,
    SecurityLevel: { BIOMETRIC_STRONG: 3 },
    authenticateAsync: async (provided) => { prompts += 1; options = provided; return { success: true }; },
    ...overrides,
  };
  const boundary = load('src/auth/biometric-authentication.native.ts', {
    'react-native': { Platform: { OS: platform } }, 'expo-local-authentication': sdk,
  });
  return { authenticate: boundary.authenticateHiddenMemos, prompts: () => prompts, options: () => options };
}

test('native prompt requires strong biometrics and disables password fallback', async () => {
  const boundary = nativeAuthentication();
  assert.equal((await boundary.authenticate()).success, true);
  assert.equal(boundary.prompts(), 1);
  assert.equal(boundary.options().disableDeviceFallback, true);
  assert.equal(boundary.options().biometricsSecurityLevel, 'strong');
  assert.equal(boundary.options().fallbackLabel, '');
});

for (const [name, overrides, message] of [
  ['no hardware', { hasHardwareAsync: async () => false }, /硬件/],
  ['not enrolled', { isEnrolledAsync: async () => false }, /录入/],
  ['only weak biometric', { getEnrolledLevelAsync: async () => 2 }, /强生物识别/],
]) {
  test(`native ${name} denies without showing a prompt`, async () => {
    const boundary = nativeAuthentication(overrides);
    const result = await boundary.authenticate();
    assert.equal(result.success, false);
    assert.match(result.message, message);
    assert.equal(boundary.prompts(), 0);
  });
}

for (const error of ['user_cancel', 'system_cancel', 'app_cancel', 'lockout', 'timeout', 'authentication_failed', 'not_available']) {
  test(`native SDK result ${error} is denied with appropriate feedback`, async () => {
    const boundary = nativeAuthentication({ authenticateAsync: async () => ({ success: false, error }) });
    const result = await boundary.authenticate();
    assert.equal(result.success, false);
    assert.equal(result.cancelled, error.endsWith('_cancel'));
    if (!result.cancelled) assert.equal(typeof result.message, 'string');
  });
}

test('iOS uses the same biometric-only policy without the Android strength precheck', async () => {
  const boundary = nativeAuthentication({ getEnrolledLevelAsync: async () => { throw new Error('Android-only'); } }, 'ios');
  assert.equal((await boundary.authenticate()).success, true);
  assert.equal(boundary.options().disableDeviceFallback, true);
});

test('missing native module and malformed SDK response fail closed', async () => {
  const boundary = load('src/auth/biometric-authentication.native.ts', {
    'react-native': { Platform: { OS: 'android' } }, 'expo-local-authentication': new Error('missing native module'),
  });
  await assert.rejects(boundary.authenticateHiddenMemos(), /升级 App/);
  await assert.rejects(nativeAuthentication({ authenticateAsync: async () => ({ success: 'yes' }) }).authenticate(), /无效/);
});

test('Web explicitly denies native biometric access', async () => {
  const boundary = load('src/auth/biometric-authentication.ts', {});
  const result = await boundary.authenticateHiddenMemos();
  assert.equal(result.success, false);
  assert.match(result.message, /Android 或 iOS/);
});

function renderEditor(memo, session, draftContent = memo.content, options = {}) {
  const states = [memo, draftContent, options.createdOn ?? memo.createdOn, options.timePickerOpen ?? false, false, memo.imageUris ?? [], memo.fileAttachments ?? [], false, options.selection ?? { start: 0, end: 0 }, 52, true, 400, 60, options.menuOpen ?? false, options.historyTags ?? [], 0, 0, options.feedback];
  let stateIndex = 0;
  const effects = [];
  const edits = [];
  const stateChanges = [];
  const copies = [], deletions = [], alerts = [];
  const memoFunctions = load('src/memos.ts', {});
  const jsx = (type, props) => ({ type, props });
  const screen = load('app/memo/[id].tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: {
      useState: (initialValue) => { const index = stateIndex++; return [index < states.length ? states[index] : initialValue, (value) => stateChanges.push([index, value])]; },
      useEffect: (effect) => effects.push(effect),
      useRef: (value) => ({ current: value }),
    },
    'expo-symbols': { SymbolView: 'Symbol' },
    'expo-router': { Stack: { Screen: 'StackScreen' }, useNavigation: () => ({ isFocused: () => true, addListener: () => () => {} }), useLocalSearchParams: () => ({ id: memo.id }), useRouter: () => ({ back() {}, replace() {} }) },
    'expo-image': { Image: 'Image' },
    'expo-clipboard': { setStringAsync: async (text) => copies.push(text) },
    '@/memos': memoFunctions,
    'expo-image-picker': {},
    '@/storage/import-file': { discardImportedFile() {} },
    '@/components/memo-editor-toolbar': { MemoEditorToolbar: 'Toolbar' },
    '@/components/memo-time-picker': { MemoTimePicker: 'TimePicker' },
    '@/components/caret-tag-suggestions': { CaretTagSuggestions: 'TagSuggestions' },
    '@/components/feedback-dialog': { FeedbackDialog: 'FeedbackDialog' },
    '@/components/file-type-icon': { FileTypeIcon: 'FileTypeIcon' },
    'react-native': { Alert: { alert: (...args) => alerts.push(args) }, Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) }, Platform: { OS: 'android' }, StyleSheet: { create: (styles) => styles }, TextInput: 'Input', View: 'View', KeyboardAvoidingView: 'KeyboardView' },
    'react-native-safe-area-context': { SafeAreaView: 'SafeArea', useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) },
    '@/components/haptic-pressable': { Pressable: 'Button' },
    '@/components/themed-text': { ThemedText: 'Text' },
    '@/constants/theme': { Spacing: { three: 12 } },
    '@/hooks/use-theme': { useTheme: () => ({}) },
    '@/storage/memos': { getMemo: async () => memo, getMemos: async () => [], deleteMemo: async (id) => deletions.push(id), updateMemoDraft: async (...parameters) => edits.push(parameters) },
    '@/auth/hidden-memo-session': { hiddenMemoSession: session },
    '@/hooks/use-hidden-memo-access': { useHiddenMemoAccess: session.getSnapshot },
  });
  const tree = screen.default();
  const nodes = [];
  function collect(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (typeof node !== 'object') return;
    nodes.push(node);
    collect(node.props?.children);
  }
  collect(tree);
  return { tree, nodes, effects, edits, stateChanges, copies, deletions, alerts };
}

const hiddenMemo = { id: 'private', hidden: true, content: 'hidden draft', imageUris: [], tags: [], createdOn: new Date(), savedAt: new Date(), fileAttachments: [{ uri: 'private-uri', name: 'private.pdf' }] };

test('direct hidden editor route renders no draft, attachment, timestamp or save control while locked', () => {
  const session = createSession(async () => ({ success: true }));
  const screen = renderEditor(hiddenMemo, session);
  assert.equal(screen.nodes.some((node) => node.type === 'Input' || node.type === 'File'), false);
  const serialized = JSON.stringify(screen.tree);
  assert.doesNotMatch(serialized, /hidden draft|private.pdf|最后保存于|保存修改/);
  assert.match(serialized, /隐藏笔记已锁定/);
});

test('locked hidden editor discards draft, hides filename and rejects previously rendered save callback', async () => {
  const session = createSession(async () => ({ success: true }));
  await session.unlock();
  const screen = renderEditor(hiddenMemo, session, 'changed hidden draft');
  const save = screen.nodes.find((node) => node.props?.accessibilityLabel === '保存修改');
  assert.ok(save);
  assert.match(JSON.stringify(screen.tree), /private.pdf/);
  const cleanups = screen.effects.map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function');
  session.setAppState('background');
  assert.ok(screen.stateChanges.some(([index, value]) => index === 1 && value === ''));
  await save.props.onPress();
  assert.equal(screen.edits.length, 0);
  const lockedScreen = renderEditor(hiddenMemo, session);
  assert.equal(lockedScreen.nodes.some((node) => node.type === 'Input' || node.type === 'File'), false);
  assert.doesNotMatch(JSON.stringify(lockedScreen.tree), /private.pdf/);
  cleanups.forEach((cleanup) => cleanup());
});

test('ordinary editor remains editable without biometric verification', async () => {
  const session = createSession(async () => { throw new Error('Must not authenticate'); });
  const screen = renderEditor({ ...hiddenMemo, hidden: false, content: 'ordinary' }, session, 'edited ordinary');
  assert.ok(screen.nodes.some((node) => node.type === 'Input'));
  await screen.nodes.find((node) => node.props?.accessibilityLabel === '保存修改').props.onPress();
  assert.equal(screen.edits.length, 1);
});

test('REQ-047 unchanged editor returns with an arrow; changed content exposes save checkmark', async () => {
  const session = createSession(async () => ({ success: true }));
  const memo = { ...hiddenMemo, hidden: false, content: 'original' };
  const original = renderEditor(memo, session);
  assert.ok(original.nodes.find((node) => node.props?.accessibilityLabel === '取消编辑'));
  assert.equal(original.nodes.some((node) => node.props?.accessibilityLabel === '保存修改'), false);
  const changed = renderEditor(memo, session, 'changed');
  const save = changed.nodes.find((node) => node.props?.accessibilityLabel === '保存修改');
  assert.ok(save); assert.equal(save.props.disabled, false);
  await save.props.onPress(); assert.equal(changed.edits.length, 1);
});

test('REQ-069 time-only change enables save and commits the selected seconds', async () => {
  const session = createSession(async () => ({ success: true }));
  const memo = { ...hiddenMemo, hidden: false };
  const createdOn = new Date('2024-02-29T23:59:47Z');
  const screen = renderEditor(memo, session, memo.content, { createdOn });
  const save = screen.nodes.find((node) => node.props?.accessibilityLabel === '保存修改');
  assert.equal(save.props.disabled, false);
  await save.props.onPress();
  assert.equal(screen.edits[0][1].createdOn.getTime(), createdOn.getTime());
});

test('REQ-069 picker cancel does not change time or persist; stale confirm cannot edit locked memo', async () => {
  const session = createSession(async () => ({ success: true }));
  await session.unlock();
  const screen = renderEditor(hiddenMemo, session, hiddenMemo.content, { timePickerOpen: true });
  const picker = screen.nodes.find((node) => node.type === 'TimePicker');
  picker.props.onCancel();
  assert.deepEqual(screen.stateChanges, [[3, false]]);
  session.lock();
  picker.props.onConfirm(new Date('2024-01-01T00:00:00Z'));
  assert.equal(screen.stateChanges.some(([index]) => index === 2), false);
  assert.equal(screen.edits.length, 0);
});

test('REQ-047/067 menu copies current draft and moves the memo to trash once', async () => {
  const session = createSession(async () => ({ success: true }));
  const memo = { ...hiddenMemo, hidden: false };
  const screen = renderEditor(memo, session, 'unsaved draft', { menuOpen: true });
  await screen.nodes.find((node) => node.props?.accessibilityLabel === '复制全文').props.onPress();
  assert.deepEqual(screen.copies, ['unsaved draft']);
  const remove = screen.nodes.find((node) => node.props?.accessibilityLabel === '删除记录');
  remove.props.onPress();
  remove.props.onPress();
  await Promise.resolve();
  assert.deepEqual(screen.deletions, ['private']);
  assert.equal(screen.stateChanges.some(([, value]) => value?.confirmDeletion), false);
});

test('REQ-067 editor deletion cannot delete a hidden memo after relocking', async () => {
  const session = createSession(async () => ({ success: true }));
  await session.unlock();
  const screen = renderEditor(hiddenMemo, session, 'unsaved draft', { menuOpen: true });
  const remove = screen.nodes.find((node) => node.props?.accessibilityLabel === '删除记录');
  assert.ok(remove);
  session.lock();
  remove.props.onPress();
  await Promise.resolve();
  assert.deepEqual(screen.deletions, []);
});

test('REQ-047 editing tag candidate replaces the cursor token and moves the selection', () => {
  const session = createSession(async () => ({ success: true }));
  const screen = renderEditor({ ...hiddenMemo, hidden: false }, session, '正文 #开 后文', { selection: { start: 5, end: 5 }, historyTags: ['开心', '工作'] });
  const candidate = screen.nodes.find((node) => node.type === 'TagSuggestions');
  assert.ok(candidate);
  assert.deepEqual(Array.from(candidate.props.tags), ['开心']);
  candidate.props.onSelect('开心');
  assert.ok(screen.stateChanges.some(([index, value]) => index === 1 && value === '正文 #开心  后文'));
  assert.ok(screen.stateChanges.some(([index, value]) => index === 8 && value.start === 7 && value.end === 7));
});

test('root lifecycle listener relocks access and is removed on unmount', async () => {
  const session = createSession(async () => ({ success: true }));
  let effect;
  let change;
  let removed = false;
  const lifecycle = load('src/hooks/use-hidden-memo-access.ts', {
    react: { useEffect: (callback) => { effect = callback; } },
    'react-native': { AppState: {
      currentState: 'active',
      addEventListener: (event, callback) => { assert.equal(event, 'change'); change = callback; return { remove: () => { removed = true; } }; },
    } },
    '@/auth/hidden-memo-session': { hiddenMemoSession: session },
  });
  lifecycle.useHiddenMemoLifecycle();
  const cleanup = effect();
  await session.unlock();
  change('background');
  assert.equal(session.getSnapshot().unlocked, false);
  change('active');
  assert.equal(session.getSnapshot().unlocked, false);
  await session.unlock();
  cleanup();
  assert.equal(session.getSnapshot().unlocked, false);
  assert.equal(removed, true);
});

function homeVisibilityCallback(session, changes, alerts) {
  const source = readFileSync(new URL('../../app/index.tsx', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function find(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'selectMemoVisibility') callback = node.getText(parsed);
    ts.forEachChild(node, find);
  }
  find(parsed);
  assert.ok(callback);
  const compiled = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${compiled}; selectMemoVisibility`, {
    hiddenMemoSession: session, Keyboard: { dismiss() {} }, showFeedback: (title, message) => alerts.push({ title, message }),
    setActiveDay: (value) => changes.push(['day', value]), setActiveTag: (value) => changes.push(['tag', value]),
    closeSearch: () => changes.push(['search', '']), setFilterOpen: (value) => changes.push(['sidebar', value]),
  });
}

test('sidebar only clears filters and closes after success; ordinary selection relocks', async () => {
  const session = createSession(async () => ({ success: true }));
  const changes = [];
  const alerts = [];
  const select = homeVisibilityCallback(session, changes, alerts);
  await select(true);
  assert.equal(session.getSnapshot().unlocked, true);
  assert.deepEqual(changes, [['day', null], ['tag', null], ['search', ''], ['sidebar', false]]);
  await select(false);
  assert.equal(session.getSnapshot().unlocked, false);
  assert.equal(alerts.length, 0);
});

test('sidebar cancellation, failure and invalidated late success never switch or clear filters', async () => {
  for (const outcome of [
    { success: false, cancelled: true },
    { success: false, cancelled: false, message: '未录入指纹' },
    new Error('SDK 不可用'),
  ]) {
    const changes = [];
    const alerts = [];
    const session = createSession(async () => { if (outcome instanceof Error) throw outcome; return outcome; });
    await homeVisibilityCallback(session, changes, alerts)(true);
    assert.equal(session.getSnapshot().unlocked, false);
    assert.equal(changes.length, 0);
    assert.equal(alerts.length, outcome.cancelled ? 0 : 1);
  }
  const attempt = deferred();
  const session = createSession(() => attempt.promise);
  const changes = [];
  const select = homeVisibilityCallback(session, changes, []);
  const pending = select(true);
  session.setAppState('background');
  session.setAppState('active');
  attempt.resolve({ success: true });
  await pending;
  assert.equal(session.getSnapshot().unlocked, false);
  assert.equal(changes.length, 0);
});

test('home clears private UI only on relocking, and hides a private image immediately', async () => {
  const source = readFileSync(new URL('../../app/index.tsx', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let subscription;
  let imageVisibility;
  function find(node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'useEffect' && node.arguments[0]?.getText(parsed).includes('previouslyUnlocked')) {
      subscription = node.arguments[0].getText(parsed);
    }
    if (ts.isJsxAttribute(node) && node.name.text === 'visible' && node.initializer?.getText(parsed).includes('Boolean(imagePreview)')) {
      imageVisibility = node.initializer.expression.getText(parsed);
    }
    ts.forEachChild(node, find);
  }
  find(parsed);
  assert.ok(subscription && imageVisibility);
  const session = createSession(async () => ({ success: false, cancelled: true }));
  const cleared = [];
  const context = {
    hiddenMemoSession: session,
    setFileActionMemo: () => cleared.push('file'),
    setOpenMemoMenuId: () => cleared.push('menu'), setImagePreview: () => cleared.push('image'),
    setExpandedMemoIds: () => cleared.push('expanded'), setQuery: () => cleared.push('query'),
    setSearchVisible: () => cleared.push('search'), setActiveDay: () => cleared.push('day'), setActiveTag: () => cleared.push('tag'),
    setSearchFiltersOpen: () => cleared.push('searchFilters'), setSearchFilters: () => {}, emptySearchFilters: () => ({}),
  };
  const compiled = ts.transpileModule(`const effect = ${subscription};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const unsubscribe = vm.runInNewContext(`(() => { ${compiled}; return effect(); })()`, context);
  await session.unlock();
  assert.equal(cleared.length, 0, 'Cancelled verification must retain ordinary filters');
  unsubscribe();
  const successful = createSession(async () => ({ success: true }));
  context.hiddenMemoSession = successful;
  const stop = vm.runInNewContext(`(() => { ${compiled}; return effect(); })()`, context);
  await successful.unlock();
  assert.equal(cleared.length, 0);
  successful.lock();
  assert.deepEqual(cleared, ['file', 'menu', 'image', 'expanded', 'query', 'search', 'searchFilters', 'day', 'tag']);
  const imageCompiled = ts.transpileModule(`const visible = ${imageVisibility};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  assert.equal(vm.runInNewContext(`${imageCompiled}; visible`, { imagePreview: { hidden: true }, hiddenMemoAccess: { unlocked: false } }), false);
  assert.equal(vm.runInNewContext(`${imageCompiled}; visible`, { imagePreview: { hidden: false }, hiddenMemoAccess: { unlocked: false } }), true);
  stop();
});
