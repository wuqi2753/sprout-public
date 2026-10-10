// REQ-087–REQ-092: real subprocesses against isolated HTTP and filesystem fixtures.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceStore } from '../dist/workspace.js';

export const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const makeNote = (id = 'note1', content = '#work hello', images = [], files = [], version = 1) => ({ note_id: id, content, version, images, files });
export const upsert = (note) => ({ action: 'upsert', note });
export function child(args, env = {}) {
  const process = spawn(globalThis.process.execPath, [join(cliRoot, 'dist/main.js'), ...args], { env: { ...globalThis.process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { process, stdout: '', stderr: '', code: undefined };
  process.stdout.on('data', (bytes) => { result.stdout += bytes; });
  process.stderr.on('data', (bytes) => { result.stderr += bytes; });
  result.done = new Promise((resolve, reject) => { process.once('error', reject); process.once('exit', (code, signal) => { result.code = code; result.signal = signal; resolve(result); }); });
  return result;
}
export async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
export async function fixture(t) {
  mkdirSync(join(cliRoot, '.tmp'), { recursive: true });
  const root = mkdtempSync(join(cliRoot, '.tmp/test-'));
  const workspace = join(root, 'workspace'); const credentials = join(root, 'credentials');
  mkdirSync(workspace); mkdirSync(credentials, { mode: 0o700 });
  const state = { requests: [], created: new Map(), pages: [], acknowledged: new Set(), subscriptions: new Map(), attachments: new Map(), override: undefined, tokenCount: 0, revokeCount: 0, counter: 0 };
  let origin;
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const form = request.headers['content-type'] === 'application/x-www-form-urlencoded';
      const body = text ? form ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text) : undefined;
      state.requests.push({ path: request.url, method: request.method, body, authorization: request.headers.authorization, at: Date.now() });
      const send = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (state.override && await state.override(request, response, body, send)) return;
      if (request.url === '/oauth/device_authorization') return send({ device_code: 'private-device', user_code: 'ABCD-EFGH', verification_uri_complete: origin + '/oauth/device?user_code=ABCD-EFGH', interval: 5, expires_in: 600 });
      if (request.url === '/oauth/token') { state.tokenCount++; return send({ token_type: 'Bearer', scope: 'notes:read subscriptions:manage', access_token: 'access-' + state.tokenCount, refresh_token: 'refresh-' + state.tokenCount, expires_in: 900 }); }
      if (request.url === '/oauth/revoke') { state.revokeCount++; response.writeHead(200); return response.end(); }
      if (!/^Bearer access-[0-9]+$/.test(request.headers.authorization ?? '')) return send({ error: { code: 'invalid_token' } }, 401);
      if (request.url === '/api/v1/tags') return send({ tags: ['work', '中文', 'work/child'] });
      if (request.url === '/api/v1/subscriptions' && request.method === 'POST') {
        let subscription = state.created.get(body.creation_key);
        if (!subscription) {
          subscription = { subscription_id: 'sub-' + ++state.counter, tags: body.tags, acknowledged_cursor: null };
          state.created.set(body.creation_key, subscription); state.subscriptions.set(subscription.subscription_id, subscription);
        }
        return send(subscription, 201);
      }
      const match = /^\/api\/v1\/subscriptions\/([^/]+)(\/[^/]+)?$/.exec(request.url);
      if (match) {
        const subscription = state.subscriptions.get(match[1]); if (!subscription) return send({ error: { code: 'not_found' } }, 404);
        if (!match[2] && request.method === 'GET') return send(subscription);
        if (!match[2] && request.method === 'PATCH') { subscription.tags = body.tags; return send(subscription); }
        if (match[2] === '/backfill') return send({ subscription_id: subscription.subscription_id });
        if (match[2] === '/pull') return send(state.pages[0] ?? { receipt: 'empty', phase: 'incremental', done: true, items: [] });
        if (match[2] === '/ack') {
          if (!state.acknowledged.has(body.receipt)) { state.acknowledged.add(body.receipt); if (state.pages[0]?.receipt === body.receipt) state.pages.shift(); }
          subscription.acknowledged_cursor = body.receipt;
          return send({ subscription_id: subscription.subscription_id });
        }
      }
      if (/^\/api\/v1\/(objects|files)\//.test(request.url)) {
        const bytes = state.attachments.get(decodeURIComponent(request.url.split('/').at(-1)));
        if (!bytes) return send({ error: { code: 'attachment_missing' } }, 404);
        response.writeHead(200); return response.end(bytes);
      }
      send({ error: { code: 'not_found' } }, 404);
    } catch { if (!response.destroyed) response.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  const workspaceIdentity = (path) => new WorkspaceStore(path).identity();
  const credentialFile = (path) => join(credentials, 'workspaces', workspaceIdentity(path), hash(origin) + '.json');
  const credentialPath = credentialFile(workspace);
  const saveWorkspaceCredentials = (path, extra = {}) => {
    const file = credentialFile(path); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ server: origin, workspace_id: workspaceIdentity(path), access_token: 'access-1', refresh_token: 'refresh-1', expires_at: Date.now() + 900000, uncertain: false, ...extra }), { mode: 0o600 });
  };
  const saveCredentials = (extra = {}) => saveWorkspaceCredentials(workspace, extra);
  saveCredentials();
  const processes = [];
  const start = (args) => {
    if (['login', 'logout', 'tags'].includes(args[0]) && !args.includes('--workspace')) args = [...args, '--workspace', workspace];
    const running = child(args, { SPROUT_CLI_CONFIG_DIR: credentials }); processes.push(running); return running;
  };
  const run = (args) => start(args).done;
  const init = (extra = []) => run(['init', '--server', origin, '--workspace', workspace, '--tags', 'work,中文', '--materials', 'materials', ...extra]);
  const workspaceState = () => JSON.parse(readFileSync(join(workspace, '.sprout/workspace.json')));
  const index = () => JSON.parse(readFileSync(join(workspace, 'materials/index.json')));
  t.after(async () => {
    for (const running of processes) if (running.code === undefined) running.process.kill('SIGKILL');
    await Promise.all(processes.map((running) => running.done));
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, credentials, origin, state, server, credentialPath, saveCredentials, saveWorkspaceCredentials, credentialFile, start, run, init, workspaceState, index };
}
