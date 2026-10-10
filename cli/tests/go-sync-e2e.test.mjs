// REQ-088..092, REQ-080/083/084: real Go binary, CLI subprocesses and persistent SQLite.
// A transparent HTTP proxy only injects transport failures; business responses come from Go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createPortReservation } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cliRoot, hash, waitFor } from './support.mjs';

async function realSyncFixture(t) {
  mkdirSync(join(cliRoot, '.tmp'), { recursive: true });
  const root = realpathSync(mkdtempSync(join(cliRoot, '.tmp/go-sync-e2e-')));
  const credentials = join(root, 'credentials'); const workspace = join(root, 'workspace');
  mkdirSync(credentials, { mode: 0o700 }); mkdirSync(workspace);
  const reservation = createPortReservation();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  const origin = 'https://notes.example.com'; const key = 'isolated-e2e-app-key';
  const binaries = []; const commands = []; let server;
  const faults = { attachment: '', attachmentReached: false, loseAck: false, lostAck: false };
  const traffic = [];
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks); traffic.push({ method: request.method, path: request.url });
      if (/^\/api\/v1\/(objects|files)\//.test(request.url) && faults.attachment) {
        faults.attachmentReached = true;
        if (faults.attachment === 'fail') { response.writeHead(502); response.end('injected attachment transport failure'); }
        return; // "hold" waits for the client to be killed; cleanup closes the socket.
      }
      const headers = { ...request.headers }; delete headers.host;
      const upstream = await fetch(endpoint + request.url, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (request.url.endsWith('/ack') && faults.loseAck && upstream.ok) {
        faults.loseAck = false; faults.lostAck = true; response.destroy(); return;
      }
      const forwarded = Object.fromEntries(upstream.headers);
      delete forwarded['transfer-encoding']; delete forwarded.connection;
      response.writeHead(upstream.status, forwarded); response.end(bytes);
    } catch (error) {
      if (!response.destroyed) { response.writeHead(502); response.end('test proxy upstream unavailable'); }
    }
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const transport = `http://127.0.0.1:${proxy.address().port}`;
  const preload = join(root, 'transport.mjs');
  writeFileSync(preload, `const original=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=new URL(input);if(url.origin!==process.env.SPROUT_TEST_ORIGIN)throw new Error('Unexpected test origin');return original(process.env.SPROUT_TEST_TRANSPORT+url.pathname+url.search,options)};`);
  const startServer = async () => {
    const processHandle = spawn(resolve(process.env.SPROUT_TEST_SERVER_BINARY), [], { cwd: root, env: { ...process.env, SPROUT_LISTEN_ADDRESS: `127.0.0.1:${port}`, SPROUT_API_KEY: key, SPROUT_DATABASE_PATH: join(root, 'server.db'), SPROUT_PUBLIC_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
    const running = { process: processHandle, stderr: '' }; processHandle.stdout.resume();
    processHandle.stderr.on('data', (bytes) => { running.stderr += bytes; });
    running.done = new Promise((resolve, reject) => { processHandle.once('error', reject); processHandle.once('exit', (code) => { running.code = code; resolve(); }); });
    binaries.push(running); server = running;
    await waitFor(() => running.stderr.includes('listening') || running.code !== undefined);
    assert.equal(running.code, undefined, running.stderr);
    const response = await fetch(endpoint + '/api/v1/health', { headers: { Authorization: 'Bearer ' + key } }); assert.equal(response.status, 200);
  };
  const stopServer = async () => { if (server.code === undefined) server.process.kill('SIGTERM'); await server.done; };
  const start = (args) => {
    if (!args.includes('--workspace')) args = [...args, '--workspace', workspace];
    const running = spawn(process.execPath, ['--import', preload, join(cliRoot, 'dist/main.js'), ...args, '--json'], { env: { ...process.env, SPROUT_CLI_CONFIG_DIR: credentials, SPROUT_TEST_ORIGIN: origin, SPROUT_TEST_TRANSPORT: transport }, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = { process: running, stdout: '', stderr: '' }; running.stdout.on('data', (bytes) => { result.stdout += bytes; }); running.stderr.on('data', (bytes) => { result.stderr += bytes; });
    result.done = new Promise((resolve, reject) => { running.once('error', reject); running.once('exit', (code, signal) => { result.code = code; result.signal = signal; resolve(result); }); }); commands.push(result); return result;
  };
  const run = async (args, expected = 0) => { const result = await start(args).done; assert.equal(result.code, expected, result.stderr + result.stdout); const envelope = JSON.parse(result.stdout); assert.equal(envelope.schema_version, 1); assert.equal(envelope.ok, expected === 0); return envelope; };
  const app = async (path, method = 'GET', body, expected = 200, extra = {}) => {
    const response = await fetch(endpoint + path, { method, headers: { Authorization: 'Bearer ' + key, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }), ...extra }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const text = await response.text(); assert.equal(response.status, expected, text); return text;
  };
  const createNote = (id, content, attachments = {}) => app('/api/v1/notes', 'POST', { note_id: id, content, created_at: '2026-10-09T00:00:00Z', ...attachments }, 201);
  const state = () => JSON.parse(readFileSync(join(workspace, '.sprout/workspace.json')));
  const index = () => JSON.parse(readFileSync(join(workspace, 'materials/index.json')));
  const subscription = () => { const db = new DatabaseSync(join(root, 'server.db'), { readOnly: true }); try { return db.prepare('SELECT * FROM workspace_subscriptions WHERE subscription_id=?').get(state().subscription_id); } finally { db.close(); } };
  t.after(async () => {
    for (const command of commands) if (command.code === undefined && command.signal === undefined) command.process.kill('SIGKILL');
    await Promise.all(commands.map((command) => command.done));
    for (const running of binaries) if (running.code === undefined) running.process.kill('SIGTERM');
    await Promise.all(binaries.map((running) => running.done));
    proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve));
    for (const releasedPort of [port, Number(new URL(transport).port)]) {
      const check = createPortReservation(); await new Promise((resolve, reject) => { check.once('error', reject); check.listen(releasedPort, '127.0.0.1', resolve); }); await new Promise((resolve) => check.close(resolve));
    }
    rmSync(root, { recursive: true, force: true });
  });
  await startServer();
  const login = start(['login', '--server', origin]);
  await waitFor(() => login.stderr.includes('authorization_required') || login.code !== undefined);
  assert.equal(login.code, undefined, login.stdout + login.stderr);
  const authorization = JSON.parse(login.stderr.split('\n').find((line) => line.startsWith('{')));
  await app('/oauth/device_requests/' + authorization.user_code + '/decision', 'POST', { decision: 'approve' });
  const logged = await login.done; assert.equal(logged.code, 0, logged.stdout + logged.stderr);
  assert.equal(JSON.parse(logged.stdout).data.authenticated, true);
  return { root, workspace, credentials, origin, endpoint, faults, traffic, start, run, app, createNote, state, index, subscription, restart: async () => { await stopServer(); await startServer(); } };
}

test('REQ-088..092 real binary E2E: login, attachment failure, process kill, restart, lost ack and material retention', { skip: !process.env.SPROUT_TEST_SERVER_BINARY, timeout: 60000 }, async (t) => {
  const f = await realSyncFixture(t);
  for (let i = 0; i < 55; i++) await f.createNote('memo' + String(i).padStart(3, '0'), '#a original');
  await f.createNote('old-b', '#b historical'); await f.createNote('old-c', '#c historical');
  const png = Buffer.from([0x89, 80, 78, 71, 13, 10, 26, 10, 9]); const pdf = Buffer.from('%PDF-1.7\ne2e');
  await f.app('/api/v1/objects/attached:0', 'PUT', png, 201, { 'Content-Type': 'image/png' });
  await f.app('/api/v1/files/attached:file', 'PUT', pdf, 201, { 'Content-Type': 'application/pdf', 'X-File-Name': 'fixture.pdf', 'X-File-SHA256': hash(pdf) });
  await f.createNote('attached', '#a with mixed attachments', { images: ['attached:0'], files: ['attached:file'] });
  const credentialPath = join(f.credentials, 'workspaces', JSON.parse(readFileSync(join(f.workspace, '.sprout/identity.json'))).workspace_id, hash(f.origin) + '.json'); const firstCredentials = JSON.parse(readFileSync(credentialPath));
  writeFileSync(credentialPath, JSON.stringify({ ...firstCredentials, expires_at: 1 }), { mode: 0o600 });
  const labels = await f.run(['tags', '--server', f.origin]); assert.deepEqual(labels.data.tags, ['a', 'b', 'c']);
  const rotated = JSON.parse(readFileSync(credentialPath)); assert.notEqual(rotated.access_token, firstCredentials.access_token); assert.notEqual(rotated.refresh_token, firstCredentials.refresh_token);
  const invalidated = await fetch(f.endpoint + '/api/v1/tags', { headers: { Authorization: 'Bearer ' + firstCredentials.access_token } }); assert.equal(invalidated.status, 401);
  await f.run(['init', '--server', f.origin, '--workspace', f.workspace, '--tags', 'a', '--materials', 'materials']);
  const originalCursor = f.subscription().acknowledged_cursor;
  f.faults.attachment = 'fail'; await f.run(['sync', '--workspace', f.workspace], 1);
  assert.equal(f.subscription().acknowledged_cursor, originalCursor); assert.ok(f.subscription().pending_receipt); assert.equal(f.state().pending_ack, undefined);
  f.faults.attachment = 'hold'; f.faults.attachmentReached = false;
  const interrupted = f.start(['sync', '--workspace', f.workspace]); await waitFor(() => f.faults.attachmentReached);
  interrupted.process.kill('SIGKILL'); assert.equal((await interrupted.done).signal, 'SIGKILL');
  assert.equal(f.subscription().acknowledged_cursor, originalCursor);
  f.faults.attachment = ''; await f.restart();
  const initial = await f.run(['sync', '--workspace', f.workspace]); assert.equal(initial.data.pages_acknowledged, 2); assert.equal(Object.keys(f.index().notes).length, 56);
  assert.deepEqual(readFileSync(join(f.workspace, 'materials', hash(png) + '.bin')), png); assert.deepEqual(readFileSync(join(f.workspace, 'materials', hash(pdf) + '.bin')), pdf);
  const subscriptionID = f.state().subscription_id;
  await f.app('/api/v1/notes/memo000', 'PATCH', { content: '#a revised', base_version: 1 });
  const beforeAck = f.subscription().acknowledged_cursor; f.faults.loseAck = true;
  await f.run(['sync', '--workspace', f.workspace], 1); assert.equal(f.faults.lostAck, true); assert.ok(f.state().pending_ack); assert.equal(f.subscription().pending_receipt, null); assert.notEqual(f.subscription().acknowledged_cursor, beforeAck);
  const afterAck = f.subscription().acknowledged_cursor; const revisedPath = join(f.workspace, 'materials', hash('memo000') + '.md'); const writtenAt = statSync(revisedPath).mtimeMs;
  await f.restart(); await f.run(['sync', '--workspace', f.workspace]); assert.equal(f.state().pending_ack, undefined); assert.equal(f.subscription().acknowledged_cursor, afterAck); assert.equal(statSync(revisedPath).mtimeMs, writtenAt); assert.equal(readFileSync(revisedPath, 'utf8'), '#a revised');
  await f.app('/api/v1/notes/memo001', 'DELETE', { base_version: 1 }); await f.run(['sync', '--workspace', f.workspace]); assert.equal(f.index().notes.memo001.updating, false); assert.equal(readFileSync(join(f.workspace, 'materials', hash('memo001') + '.md'), 'utf8'), '#a original');
  await f.app('/api/v1/notes/memo001/restore', 'POST', { base_version: 2 }); await f.run(['sync', '--workspace', f.workspace]); assert.equal(f.index().notes.memo001.updating, true); assert.equal(f.index().notes.memo001.version, 3);
  await f.app('/api/v1/notes/attached/purge', 'POST', { base_version: 1 }); await f.run(['sync', '--workspace', f.workspace]); assert.equal(f.index().notes.attached.updating, false); assert.deepEqual(readFileSync(join(f.workspace, 'materials', hash(pdf) + '.bin')), pdf);
  const noConsent = await f.run(['set-tags', '--workspace', f.workspace, '--tags', 'a,b'], 1); assert.equal(noConsent.ok, false); assert.deepEqual(f.state().tags, ['a']);
  const backfillCursor = f.subscription().acknowledged_cursor;
  await f.run(['set-tags', '--workspace', f.workspace, '--tags', 'a,b', '--backfill', 'yes']); assert.equal(f.subscription().acknowledged_cursor, backfillCursor);
  await f.restart(); await f.run(['sync', '--workspace', f.workspace]); assert.ok(f.index().notes['old-b']); assert.equal(f.subscription().acknowledged_cursor, backfillCursor);
  await f.run(['set-tags', '--workspace', f.workspace, '--tags', 'a,b,c', '--backfill', 'no']); await f.run(['sync', '--workspace', f.workspace]); assert.equal(f.index().notes['old-c'], undefined);
  await f.createNote('new-c', '#c new'); await f.run(['sync', '--workspace', f.workspace]); assert.ok(f.index().notes['new-c']); assert.equal(f.state().subscription_id, subscriptionID);
  const access = JSON.parse(readFileSync(credentialPath)).access_token;
  await f.run(['logout', '--server', f.origin]); assert.equal(existsSync(credentialPath), false);
  const revoked = await fetch(f.endpoint + '/api/v1/tags', { headers: { Authorization: 'Bearer ' + access } }); assert.equal(revoked.status, 401);
  const afterLogout = await f.run(['sync', '--workspace', f.workspace], 1); assert.equal(afterLogout.ok, false);
  for (const command of [initial, labels, afterLogout]) assert.doesNotMatch(JSON.stringify(command), new RegExp(rotated.access_token + '|' + rotated.refresh_token));
  t.diagnostic('real Device Flow; 56-note pagination; PNG/PDF bytes; transport failure; SIGKILL; 3 Server restarts; lost committed ack; delete/restore/purge retention; consent and backfill yes/no; refresh and revoke verified');
});

test('REQ-084/091 real binary E2E: 500 unmatched changes followed by a matching change', { skip: !process.env.SPROUT_TEST_SERVER_BINARY, timeout: 60000 }, async (t) => {
  const f = await realSyncFixture(t);
  await f.run(['init', '--server', f.origin, '--workspace', f.workspace, '--tags', 'a', '--materials', 'materials']); await f.run(['sync', '--workspace', f.workspace]);
  for (let i = 0; i < 500; i++) await f.createNote('unmatched' + i, '#other'); await f.createNote('match501', '#a after empty scan');
  const result = await f.run(['sync', '--workspace', f.workspace]); assert.equal(result.data.pages_acknowledged, 2); assert.deepEqual(Object.keys(f.index().notes), ['match501']);
  assert.equal(readFileSync(join(f.workspace, 'materials', hash('match501') + '.md'), 'utf8'), '#a after empty scan');
  assert.equal(f.traffic.filter((request) => request.path.endsWith('/pull')).length, 3);
  t.diagnostic('first incremental page empty, acknowledged and continued; 501st matching change saved and confirmed');
});
