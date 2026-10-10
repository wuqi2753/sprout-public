// REQ-098: run the actual page script, including approved -> consumed and errors.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const script = readFileSync(new URL('../../server/device_page.go', import.meta.url), 'utf8').match(/const deviceCountdownScript = `([\s\S]*?)`/)[1];
function browser(responses) {
  let main = { dataset: { state: 'pending' }, replaceWith(next) { main = next; main.replaceWith = this.replaceWith; } };
  const hint = { textContent: '' }; const timers = []; const listeners = {}; const calls = [];
  vm.runInNewContext(script, {
    window: { addEventListener: (name, callback) => { listeners[name] = callback; } },
    document: { querySelector: (selector) => selector === 'main' ? main : null, getElementById: (id) => id === 'poll-error' ? hint : null },
    location: { pathname: '/oauth/device', search: '?user_code=ABCD-1234' }, Date, AbortController,
    setInterval: () => {}, setTimeout: (callback, delay) => { timers.push({ callback, delay }); return callback; }, clearTimeout: () => {},
    fetch: async (url, options) => { calls.push({ url, options }); const state = responses.shift(); if (state === 'error') throw new Error('offline'); return { ok: true, text: async () => state }; },
    DOMParser: class { parseFromString(state) { return { querySelector: () => ({ dataset: { state } }) }; } },
  });
  return { calls, hint, listeners, state: () => main.dataset.state, poll: async () => {
    const next = timers.findIndex((timer) => timer.delay === 3000);
    assert.notEqual(next, -1); await timers.splice(next, 1)[0].callback();
  } };
}
test('page polls serially, shows approved before consumed, then stops HTTP requests', async () => {
  const page = browser(['approved', 'consumed']);
  await page.poll(); assert.equal(page.state(), 'approved');
  await page.poll(); assert.equal(page.state(), 'consumed');
  await page.poll(); assert.equal(page.calls.length, 2);
  assert.equal(page.calls[0].url, '/oauth/device?user_code=ABCD-1234');
  assert.equal(page.calls[0].options.redirect, 'error');
});
test('network failure shows retry feedback and pagehide prevents further requests', async () => {
  const page = browser(['error', 'denied']);
  await page.poll(); assert.match(page.hint.textContent, /重试/); assert.equal(page.state(), 'pending');
  await page.poll(); assert.equal(page.state(), 'denied'); assert.equal(page.hint.textContent, '');
  page.listeners.pagehide(); await page.poll(); assert.equal(page.calls.length, 2);
});
