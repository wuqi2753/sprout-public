// REQ-064: docs/stories/v0.2.0/REQ-064-camera-capture.md
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../app/index.tsx', import.meta.url), 'utf8');
const captureFunction = source.slice(source.indexOf('  async function captureMemoPhoto()'), source.indexOf('  function addTagPrompt()'));

async function capture({ granted = true, canceled = false, failure, images = ['existing'], files = [], busy = false, assets = [{ uri: 'file://photo.jpg' }] } = {}) {
  const feedback = [];
  const importing = [];
  let photos = [...images];
  let launches = 0;
  let permissionRequests = 0;
  const context = vm.createContext({
    importingFile: busy, savingMemo: false, imageUris: images, fileAttachments: files,
    setImportingFile: (value) => importing.push(value),
    setImageUris: (append) => { photos = Array.from(append(photos)); },
    showFeedback: (...message) => feedback.push(message),
    ImagePicker: {
      requestCameraPermissionsAsync: async () => { permissionRequests++; return { granted, canAskAgain: false }; },
      launchCameraAsync: async () => { launches++; if (failure) throw new Error(failure); return { canceled, assets }; },
    },
  });
  await vm.runInContext(`${captureFunction}\ncaptureMemoPhoto()`, context);
  return { photos, feedback, importing, launches, permissionRequests };
}

test('confirmed photo appends without replacing existing images', async () => {
  const result = await capture();
  assert.deepEqual(result.photos, ['existing', 'file://photo.jpg']);
  assert.deepEqual(result.importing, [true, false]);
  assert.equal(result.launches, 1);
});

test('cancellation preserves the draft and releases busy state', async () => {
  const result = await capture({ canceled: true });
  assert.deepEqual(result.photos, ['existing']);
  assert.equal(result.feedback.length, 0);
  assert.deepEqual(result.importing, [true, false]);
});

test('permission refusal preserves draft and explains system settings', async () => {
  const result = await capture({ granted: false });
  assert.equal(result.launches, 0);
  assert.deepEqual(result.photos, ['existing']);
  assert.match(result.feedback[0][1], /系统设置/);
  assert.deepEqual(result.importing, [true, false]);
});

test('camera failure or missing photo reports failure and preserves draft', async () => {
  for (const options of [{ failure: 'unavailable' }, { assets: [] }]) {
    const result = await capture(options);
    assert.deepEqual(result.photos, ['existing']);
    assert.equal(result.feedback[0][0], '无法拍照');
    assert.deepEqual(result.importing, [true, false]);
  }
});

test('busy and five mixed attachments prevent requesting camera access', async () => {
  for (const options of [{ busy: true }, { files: [{}, {}, {}, {}] }]) {
    const result = await capture(options);
    assert.equal(result.permissionRequests, 0);
    assert.equal(result.launches, 0);
  }
});
