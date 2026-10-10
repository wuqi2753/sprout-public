import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { child, fixture, hash, makeNote, upsert, waitFor } from './support.mjs';

test('REQ-087 help/version and invalid arguments have precise exit codes', async () => {
  for (const args of [[], ['--help'], ['--version']]) assert.equal((await child(args).done).code, 0);
  const credentialURL = 'https://' + 'user:secret' + '@' + 'example.com';
  for (const args of [['unknown'], ['sync'], ['sync', '--workspace', '.', '--unknown'], ['login', '--server', 'http://remote.example.com'], ['login', '--server', credentialURL]]) assert.equal((await child(args).done).code, 2);
});

test('REQ-088 mock login, refresh and revoke use independent safe credentials', async (t) => {
  const f = await fixture(t); rmSync(f.credentialPath);
  const logged = await f.run(['login', '--server', f.origin]); assert.equal(logged.code, 0, logged.stderr);
  assert.match(logged.stderr, /ABCD-EFGH/); assert.doesNotMatch(logged.stdout + logged.stderr, /private-device|refresh-1|access-1/);
  f.saveCredentials({ expires_at: 1 });
  assert.equal((await f.run(['tags', '--server', f.origin])).code, 0);
  const refresh = f.state.requests.find((request) => request.body?.grant_type === 'refresh_token'); assert.equal(refresh.body.refresh_token, 'refresh-1');
  assert.equal(JSON.parse(readFileSync(f.credentialPath)).refresh_token, 'refresh-2');
  assert.equal((await f.run(['logout', '--server', f.origin])).code, 0); assert.equal(existsSync(f.credentialPath), false);
});

test('REQ-088 uncertain refresh never replays the old refresh token', async (t) => {
  const f = await fixture(t); f.saveCredentials({ expires_at: 1 });
  f.state.override = (request, response) => { if (request.url === '/oauth/token') { response.destroy(); return true; } };
  assert.equal((await f.run(['tags', '--server', f.origin])).code, 1);
  assert.equal(JSON.parse(readFileSync(f.credentialPath)).uncertain, true);
  const retry = await f.run(['tags', '--server', f.origin]); assert.equal(retry.code, 1); assert.match(retry.stderr, /uncertain/);
  assert.equal(f.state.requests.filter((request) => request.path === '/oauth/token').length, 1);
  f.state.override = undefined;
  assert.equal((await f.run(['logout', '--server', f.origin])).code, 0);
});

test('REQ-088 revoke failure preserves credentials, permission errors fail closed', async (t) => {
  const f = await fixture(t);
  f.state.override = (request, response, body, send) => { if (request.url === '/oauth/revoke') { send({ error: 'temporarily_unavailable' }, 503); return true; } };
  assert.equal((await f.run(['logout', '--server', f.origin])).code, 1); assert.equal(existsSync(f.credentialPath), true);
  chmodSync(f.credentialPath, 0o644); assert.equal((await f.run(['tags', '--server', f.origin])).code, 1);
  chmodSync(f.credentialPath, 0o600); f.state.override = undefined;
  assert.equal((await f.run(['logout', '--server', f.origin])).code, 0);
});

test('REQ-088 refuses an untrusted verification URL without polling', async (t) => {
  const f = await fixture(t); rmSync(f.credentialPath);
  f.state.override = (request, response, body, send) => { if (request.url === '/oauth/device_authorization') { send({ device_code: 'hidden', user_code: 'ABCD-EFGH', verification_uri_complete: 'https://evil.example.com/oauth/device?user_code=ABCD-EFGH', interval: 5, expires_in: 600 }); return true; } };
  const result = await f.run(['login', '--server', f.origin]); assert.equal(result.code, 1); assert.match(result.stderr, /untrusted/);
  assert.equal(f.state.requests.filter((request) => request.path === '/oauth/token').length, 0);
});

test('REQ-088 pending/slow_down respect intervals, interrupt releases lock', async (t) => {
  const f = await fixture(t); rmSync(f.credentialPath); let polls = 0;
  f.state.override = (request, response, body, send) => { if (request.url === '/oauth/token') { polls++; send({ error: polls === 1 ? 'authorization_pending' : 'slow_down' }, 400); return true; } };
  const running = f.start(['login', '--server', f.origin]); await waitFor(() => polls === 2, 13000);
  const calls = f.state.requests.filter((request) => request.path === '/oauth/token'); assert.ok(calls[1].at - calls[0].at >= 4900);
  await new Promise((resolve) => setTimeout(resolve, 500)); assert.equal(polls, 2);
  running.process.kill('SIGINT'); assert.equal((await running.done).code, 130); assert.equal(existsSync(f.credentialPath), false);
});

test('REQ-088 denied and expired device requests diagnose terminal states', async (t) => {
  const f = await fixture(t); rmSync(f.credentialPath);
  f.state.override = (request, response, body, send) => {
    if (request.url === '/oauth/token') { send({ error: 'access_denied' }, 400); return true; }
  };
  const denied = await f.run(['login', '--server', f.origin]); assert.equal(denied.code, 1); assert.match(denied.stderr, /access_denied/);
  f.state.override = (request, response, body, send) => {
    if (request.url === '/oauth/device_authorization') { send({ device_code: 'hidden', user_code: 'ABCD-EFGH', verification_uri_complete: f.origin + '/oauth/device?user_code=ABCD-EFGH', interval: 5, expires_in: 1 }); return true; }
  };
  const expired = await f.run(['login', '--server', f.origin]); assert.equal(expired.code, 1); assert.match(expired.stderr, /expired/);
});

test('REQ-089 discovery, independent subscriptions and authoritative status', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(['tags', '--server', f.origin])).code, 0);
  assert.equal((await f.init()).code, 0);
  const first = f.workspaceState().subscription_id;
  const status = await f.run(['status', '--workspace', f.workspace]); assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).subscription_id, first);
  assert.equal((await f.run(['init', '--server', f.origin, '--workspace', f.workspace, '--tags', 'work,中文', '--materials', 'materials2', '--rebuild'])).code, 0);
  assert.notEqual(f.workspaceState().subscription_id, first); assert.equal(existsSync(join(f.workspace, 'materials')), true);
});

test('REQ-089 lost create response reuses persisted creation key after restart', async (t) => {
  const f = await fixture(t); let first = true;
  f.state.override = (request, response, body) => {
    if (request.url === '/api/v1/subscriptions' && first) {
      first = false; const subscription = { subscription_id: 'recovered', tags: body.tags, acknowledged_cursor: null };
      f.state.created.set(body.creation_key, subscription); f.state.subscriptions.set('recovered', subscription); response.destroy(); return true;
    }
  };
  assert.equal((await f.init()).code, 1); const key = f.workspaceState().creation_key;
  assert.equal((await f.init()).code, 0); assert.equal(f.workspaceState().creation_key, key); assert.equal(f.workspaceState().subscription_id, 'recovered'); assert.equal(f.state.created.size, 1);
});

test('REQ-089 refuses traversal, symlinks, corrupt state and implicit server changes', async (t) => {
  const f = await fixture(t);
  const escape = await f.run(['init', '--server', f.origin, '--workspace', f.workspace, '--tags', 'work', '--materials', '../outside']); assert.equal(escape.code, 1);
  symlinkSync(f.root, join(f.workspace, 'linked')); assert.equal((await f.run(['init', '--server', f.origin, '--workspace', f.workspace, '--tags', 'work', '--materials', 'linked/new'])).code, 1);
  assert.equal((await f.init()).code, 0);
  assert.equal((await f.run(['init', '--server', 'https://different.example.com', '--workspace', f.workspace, '--tags', 'work,中文', '--materials', 'materials'])).code, 1);
  writeFileSync(join(f.workspace, '.sprout/workspace.json'), '{'); assert.equal((await f.run(['status', '--workspace', f.workspace])).code, 1);
});

test('REQ-090 paginated material and mixed attachments become durable before ack', async (t) => {
  const f = await fixture(t); assert.equal((await f.init()).code, 0);
  f.state.attachments.set('note1:0', Buffer.from('image')); f.state.attachments.set('note1:file', Buffer.from('document'));
  f.state.pages = [{ receipt: 'first', phase: 'initial', done: false, items: Array.from({ length: 50 }, (_, index) => upsert(makeNote('n' + index))) }, { receipt: 'second', phase: 'initial', done: true, items: [upsert(makeNote('note1', '#work 中文', ['note1:0'], ['note1:file']))] }];
  f.state.override = (request) => { if (request.url.endsWith('/ack')) { assert.ok(Object.keys(f.index().notes).length >= 50); assert.ok(f.workspaceState().pending_ack); } };
  const result = await f.run(['sync', '--workspace', f.workspace]); assert.equal(result.code, 0, result.stderr);
  const index = f.index(); assert.equal(Object.keys(index.notes).length, 51); assert.equal(readFileSync(join(f.workspace, 'materials', index.notes.note1.content), 'utf8'), '#work 中文');
  assert.equal(Object.keys(index.notes.note1.attachments).length, 2); assert.deepEqual([...f.state.acknowledged], ['first', 'second']);
});

test('REQ-090 attachment failure never ack, reread current references succeeds', async (t) => {
  const f = await fixture(t); await f.init();
  f.state.pages = [{ receipt: 'p', phase: 'initial', done: true, items: [upsert(makeNote('note1', '#work', ['note1:0']))] }];
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 1); assert.equal(f.state.acknowledged.size, 0);
  f.state.pages[0].items = [upsert(makeNote('note1', '#work new reference', [], [], 2))];
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0); assert.equal(f.index().notes.note1.version, 2);
});

test('REQ-090 disk collision and invalid HTTP data do not overwrite or acknowledge', async (t) => {
  const f = await fixture(t); await f.init();
  const path = join(f.workspace, 'materials', hash('note1') + '.md'); writeFileSync(path, 'user material');
  f.state.pages = [{ receipt: 'p', phase: 'initial', done: true, items: [upsert(makeNote())] }];
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 1); assert.equal(readFileSync(path, 'utf8'), 'user material'); assert.equal(f.state.acknowledged.size, 0);
  f.state.pages[0].items = [{ action: 'unknown' }]; assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 1); assert.equal(f.state.acknowledged.size, 0);
});

test('REQ-090 OS lock blocks another process and is released on SIGKILL', async (t) => {
  const f = await fixture(t); await f.init(); let holding = false;
  f.state.override = (request) => { if (request.url.endsWith('/pull')) { holding = true; return true; } };
  const first = f.start(['sync', '--workspace', f.workspace]); await waitFor(() => holding);
  const second = await f.run(['sync', '--workspace', f.workspace]); assert.equal(second.code, 1); assert.match(second.stderr, /currently in use/);
  first.process.kill('SIGKILL'); await first.done; f.state.override = undefined;
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0);
});

test('REQ-091 empty page continues; stop retains attachments; restore updates one note', async (t) => {
  const f = await fixture(t); await f.init(); f.state.attachments.set('note1:0', Buffer.from('retain'));
  f.state.pages = [{ receipt: 'empty1', phase: 'incremental', done: false, items: [] }, { receipt: 'matched', phase: 'incremental', done: true, items: [upsert(makeNote('note1', '#work v1', ['note1:0']))] }];
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0); const old = f.index().notes.note1;
  f.state.pages = [{ receipt: 'deleted', phase: 'incremental', done: true, items: [{ action: 'stop', note_id: 'note1' }] }];
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0); assert.equal(f.index().notes.note1.updating, false); assert.equal(existsSync(join(f.workspace, 'materials', old.attachments['note1:0'])), true);
  f.state.pages = [{ receipt: 'restored', phase: 'incremental', done: true, items: [upsert(makeNote('note1', '#work v2', [], [], 2))] }];
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0); assert.equal(f.index().notes.note1.updating, true); assert.equal(f.index().notes.note1.version, 2);
  assert.equal(Object.keys(f.index().notes).length, 1); assert.equal(readFileSync(join(f.workspace, 'materials', old.content), 'utf8'), '#work v2');
});

test('REQ-091 lost ack response retries exact receipt without pulling a new round', async (t) => {
  const f = await fixture(t); await f.init(); let first = true;
  f.state.pages = [{ receipt: 'lost-ack', phase: 'incremental', done: true, items: [upsert(makeNote())] }];
  f.state.override = (request, response, body) => {
    if (request.url.endsWith('/ack') && first) { first = false; f.state.acknowledged.add(body.receipt); f.state.pages.shift(); response.destroy(); return true; }
  };
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 1); assert.equal(f.workspaceState().pending_ack.receipt, 'lost-ack');
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0); assert.equal(f.workspaceState().pending_ack, undefined);
  assert.equal(f.state.requests.filter((request) => request.path.endsWith('/pull')).length, 1);
  assert.equal(f.state.requests.filter((request) => request.path.endsWith('/ack')).length, 2);
});

test('REQ-091 missing local material explicitly requires rebuild', async (t) => {
  const f = await fixture(t); await f.init(); f.state.pages = [{ receipt: 'p', phase: 'initial', done: true, items: [upsert(makeNote())] }];
  await f.run(['sync', '--workspace', f.workspace]); rmSync(join(f.workspace, 'materials', f.index().notes.note1.content));
  const result = await f.run(['sync', '--workspace', f.workspace]); assert.equal(result.code, 1); assert.match(result.stderr, /rebuild/);
});

test('REQ-092 no implied backfill, order-only no-op, explicit removal retains material', async (t) => {
  const f = await fixture(t); await f.init();
  const run = (labels, extra = []) => f.run(['set-tags', '--workspace', f.workspace, '--tags', labels, ...extra]);
  assert.equal((await run('new,work')).code, 1); assert.equal(f.state.requests.filter((request) => request.method === 'PATCH').length, 0);
  assert.equal((await run('中文,work,work')).code, 0); assert.equal(f.state.requests.filter((request) => request.method === 'PATCH').length, 0);
  const original = f.workspaceState().subscription_id;
  assert.equal((await run('work,new', ['--backfill', 'no'])).code, 0); assert.equal(f.workspaceState().subscription_id, original);
  assert.equal(f.state.requests.filter((request) => request.path.endsWith('/backfill')).length, 0);
  assert.equal(existsSync(join(f.workspace, 'materials')), true);
});

test('REQ-092 failed backfill start resumes original operation and then incremental', async (t) => {
  const f = await fixture(t); await f.init(); let fail = true;
  f.state.override = (request, response) => { if (request.url.endsWith('/backfill') && fail) { fail = false; response.destroy(); return true; } };
  const args = ['set-tags', '--workspace', f.workspace, '--tags', 'work,中文,new', '--backfill', 'yes'];
  assert.equal((await f.run(args)).code, 1); const id = f.workspaceState().tag_change.request_id;
  assert.deepEqual(f.workspaceState().tags, ['work', '中文']);
  assert.equal((await f.run(args)).code, 0); assert.equal(f.workspaceState().tag_change, undefined);
  const starts = f.state.requests.filter((request) => request.path.endsWith('/backfill')); assert.equal(starts.length, 2); assert.deepEqual(starts[0].body, { tags: ['new'], request_id: id }); assert.deepEqual(starts[1].body, starts[0].body);
  f.state.pages = [{ receipt: 'back', phase: 'backfill', done: true, items: [upsert(makeNote('newnote', '#new'))] }, { receipt: 'later', phase: 'incremental', done: true, items: [upsert(makeNote('note1', '#work changed'))] }];
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0); assert.equal(Object.keys(f.index().notes).length, 2);
});

test('REQ-090 lock transaction fails closed while another database owns it', async (t) => {
  const f = await fixture(t); await f.init(); const db = new DatabaseSync(join(f.workspace, '.sprout/lock.sqlite'));
  try { db.exec('BEGIN EXCLUSIVE'); assert.equal((await f.run(['status', '--workspace', f.workspace])).code, 1); } finally { db.close(); }
});

test('REQ-087 Agent discovers descriptions, schemas and side effects without login', async () => {
  const result = await child(['describe', '--json']).done; assert.equal(result.code, 0);
  const manifest = JSON.parse(result.stdout); assert.equal(manifest.ok, true); assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.data.tools.length, 7);
  for (const tool of manifest.data.tools) { assert.ok(tool.description.length > 30); assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false); assert.ok(tool.outputSchema.oneOf); assert.ok(tool.effects.length); }
  const sync = manifest.data.tools.find((tool) => tool.name === 'sync'); assert.deepEqual(sync.inputSchema.required, ['workspace']);
  const tags = manifest.data.tools.find((tool) => tool.name === 'set-tags'); assert.deepEqual(tags.inputSchema.properties.backfill.enum, ['yes', 'no']); assert.equal(tags.inputSchema.properties.tags.type, 'array');
});

test('REQ-087 Agent JSON input is validated and returns stable machine errors', async () => {
  for (const input of [{ workspace: 3 }, { workspace: '.', unexpected: true }, {}]) {
    const result = await child(['call', 'sync', '--input', JSON.stringify(input)]).done;
    assert.equal(result.code, 2); const output = JSON.parse(result.stdout); assert.equal(output.ok, false); assert.equal(output.error.code, 'INVALID_ARGUMENTS'); assert.equal(output.error.retryable, false); assert.ok(output.error.next_action);
  }
  const result = await child(['sync', '--workspace', '.', '--workspace', '.', '--json']).done; assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGUMENTS');
});

test('REQ-089/REQ-092 Agent call returns one JSON result and explicit consent request', async (t) => {
  const f = await fixture(t);
  const initialized = await f.run(['call', 'init', '--input', JSON.stringify({ server: f.origin, workspace: f.workspace, tags: ['work', '中文'], materials: 'materials' })]);
  assert.equal(initialized.code, 0, initialized.stderr); assert.equal(JSON.parse(initialized.stdout).data.subscription_id, f.workspaceState().subscription_id);
  const choice = await f.run(['call', 'set-tags', '--input', JSON.stringify({ workspace: f.workspace, tags: ['work', 'new'] })]);
  assert.equal(choice.code, 1); const failure = JSON.parse(choice.stdout); assert.equal(failure.error.code, 'INPUT_REQUIRED'); assert.match(failure.error.next_action, /Ask the user/); assert.equal(f.state.requests.filter((request) => request.method === 'PATCH').length, 0);
  const synced = await f.run(['call', 'sync', '--input', JSON.stringify({ workspace: f.workspace })]); assert.equal(synced.code, 0); assert.deepEqual(Object.keys(JSON.parse(synced.stdout).data).sort(), ['index', 'materials', 'notes_known', 'pages_acknowledged']);
});

test('REQ-090 disk write failure leaves receipt unconfirmed and retry recovers', async (t) => {
  const f = await fixture(t); await f.init(); const materialDirectory = join(f.workspace, 'materials');
  f.state.pages = [{ receipt: 'disk', phase: 'initial', done: true, items: [upsert(makeNote())] }];
  chmodSync(materialDirectory, 0o500);
  try { assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 1); assert.equal(f.state.acknowledged.size, 0); }
  finally { chmodSync(materialDirectory, 0o700); }
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0);
});

test('REQ-091 killed process after durable material resumes ack without a new pull', async (t) => {
  const f = await fixture(t); await f.init(); let waiting = false;
  f.state.pages = [{ receipt: 'kill', phase: 'incremental', done: true, items: [upsert(makeNote())] }];
  f.state.override = (request) => { if (request.url.endsWith('/ack')) { waiting = true; return true; } };
  const running = f.start(['sync', '--workspace', f.workspace]); await waitFor(() => waiting); assert.equal(f.workspaceState().pending_ack.receipt, 'kill');
  running.process.kill('SIGKILL'); await running.done; f.state.override = undefined;
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0); assert.equal(f.state.requests.filter((request) => request.path.endsWith('/pull')).length, 1);
});

test('REQ-090/REQ-099 different workspaces using independent credentials can sync concurrently', async (t) => {
  const f = await fixture(t); await f.init(); const other = join(f.root, 'other-workspace'); mkdirSync(other);
  f.saveWorkspaceCredentials(other);
  assert.equal((await f.run(['init', '--server', f.origin, '--workspace', other, '--tags', 'work,中文', '--materials', 'materials'])).code, 0);
  assert.notEqual(JSON.parse(readFileSync(join(other, '.sprout/workspace.json'))).subscription_id, f.workspaceState().subscription_id);
  let waiting = false;
  f.state.override = (request) => { if (request.url === '/api/v1/subscriptions/sub-1/pull') { waiting = true; return true; } };
  const first = f.start(['sync', '--workspace', f.workspace]); await waitFor(() => waiting);
  assert.equal((await f.run(['sync', '--workspace', other])).code, 0); first.process.kill('SIGINT'); assert.equal((await first.done).code, 130);
});

test('REQ-091 lost pull response recovers and done leaves later changes for next run', async (t) => {
  const f = await fixture(t); await f.init(); let fail = true;
  f.state.pages = [{ receipt: 'cutoff', phase: 'incremental', done: true, items: [upsert(makeNote())] }, { receipt: 'after-cutoff', phase: 'incremental', done: true, items: [upsert(makeNote('later'))] }];
  f.state.override = (request, response) => { if (request.url.endsWith('/pull') && fail) { fail = false; response.destroy(); return true; } };
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 1); assert.equal(f.state.acknowledged.size, 0);
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0); assert.equal(f.state.pages[0].receipt, 'after-cutoff'); assert.equal(f.index().notes.later, undefined);
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0); assert.equal(f.index().notes.later.note_id, 'later');
});

test('REQ-088 storage failure after rotation leaves uncertain marker, no replay', async (t) => {
  const f = await fixture(t); f.saveCredentials({ expires_at: 1 }); f.state.tokenCount = 1;
  f.state.override = (request) => { if (request.url === '/oauth/token') chmodSync(join(f.credentialPath, '..'), 0o500); };
  try {
    const result = await f.run(['tags', '--server', f.origin, '--json']); assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).error.code, 'AUTH_UNCERTAIN');
    assert.equal(JSON.parse(readFileSync(f.credentialPath)).uncertain, true); assert.doesNotMatch(result.stdout + result.stderr, /access-2|refresh-2/);
  } finally { chmodSync(join(f.credentialPath, '..'), 0o700); }
  f.state.override = undefined;
  assert.equal((await f.run(['tags', '--server', f.origin])).code, 1); assert.equal(f.state.tokenCount, 2);
});
