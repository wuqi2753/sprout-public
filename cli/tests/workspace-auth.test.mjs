// REQ-099: real CLI subprocesses prove credentials are selected by root, not Server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { child, fixture, hash } from './support.mjs';

test('REQ-099 workspace is mandatory for authentication and advertised to Agents', async () => {
  for (const command of ['login', 'logout', 'tags']) {
    const result = await child([command, '--server', 'https://notes.example.com', '--json']).done;
    assert.equal(result.code, 2);
    assert.match(JSON.parse(result.stdout).error.message, /workspace is required/);
  }
  const manifest = JSON.parse((await child(['describe', '--json']).done).stdout).data;
  for (const name of ['login', 'logout', 'tags']) assert.ok(manifest.tools.find(tool => tool.name === name).inputSchema.required.includes('workspace'));
});

test('REQ-099 another root and legacy shared credentials cannot bypass its login', async t => {
  const f = await fixture(t);
  const other = join(f.root, 'other'); mkdirSync(other);
  writeFileSync(join(f.credentials, hash(f.origin) + '.json'), readFileSync(f.credentialPath), { mode: 0o600 });
  for (const args of [
    ['tags', '--server', f.origin, '--workspace', other],
    ['init', '--server', f.origin, '--workspace', other, '--tags', 'work', '--materials', 'materials'],
  ]) {
    const result = await f.run([...args, '--json']);
    assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).error.code, 'AUTH_REQUIRED');
  }
  assert.equal(f.state.requests.length, 0);
  assert.equal(existsSync(join(other, '.sprout/workspace.json')), false);
  assert.equal(existsSync(f.credentialPath), true);
});

test('REQ-099 separate logins, refresh and logout leave the other root unchanged', async t => {
  const f = await fixture(t); rmSync(f.credentialPath);
  const other = join(f.root, 'other'); mkdirSync(other);
  for (const workspace of [f.workspace, other]) assert.equal((await f.run(['login', '--server', f.origin, '--workspace', workspace])).code, 0);
  const otherFile = f.credentialFile(other);
  const first = JSON.parse(readFileSync(f.credentialPath));
  const secondBytes = readFileSync(otherFile, 'utf8'); const second = JSON.parse(secondBytes);
  assert.notEqual(first.workspace_id, second.workspace_id);
  assert.notEqual(first.refresh_token, second.refresh_token);
  assert.equal(statSync(dirname(otherFile)).mode & 0o077, 0);
  assert.equal(statSync(otherFile).mode & 0o077, 0);
  f.saveCredentials({ ...first, expires_at: 1 });
  assert.equal((await f.run(['tags', '--server', f.origin])).code, 0);
  assert.notEqual(JSON.parse(readFileSync(f.credentialPath)).refresh_token, first.refresh_token);
  assert.equal(readFileSync(otherFile, 'utf8'), secondBytes);
  assert.equal((await f.run(['logout', '--server', f.origin])).code, 0);
  assert.equal(existsSync(f.credentialPath), false);
  assert.equal(readFileSync(otherFile, 'utf8'), secondBytes);
  assert.equal((await f.run(['tags', '--server', f.origin, '--workspace', other])).code, 0);
  assert.equal(f.state.requests.filter(request => request.path === '/oauth/device_authorization').length, 2);
});

test('REQ-099 root identity is stable; copied identity cannot inherit credentials', async t => {
  const f = await fixture(t);
  const identityPath = join(f.workspace, '.sprout/identity.json');
  const first = readFileSync(identityPath, 'utf8');
  const relativeRoot = relative(process.cwd(), f.workspace);
  assert.equal((await f.run(['tags', '--server', f.origin, '--workspace', relativeRoot])).code, 0);
  assert.equal(readFileSync(identityPath, 'utf8'), first);
  const other = join(f.root, 'copy'); mkdirSync(other);
  cpSync(join(f.workspace, '.sprout'), join(other, '.sprout'), { recursive: true });
  const result = await f.run(['tags', '--server', f.origin, '--workspace', other, '--json']);
  assert.equal(JSON.parse(result.stdout).error.code, 'AUTH_REQUIRED');
  assert.notEqual(JSON.parse(readFileSync(join(other, '.sprout/identity.json'))).workspace_id, JSON.parse(first).workspace_id);
  assert.equal(readFileSync(identityPath, 'utf8'), first);
});

test('REQ-099 corrupt identity, broad permissions and mismatched credentials fail before HTTP', async t => {
  const f = await fixture(t); const identityPath = join(f.workspace, '.sprout/identity.json');
  const original = readFileSync(identityPath);
  writeFileSync(identityPath, '{}');
  assert.equal((await f.run(['tags', '--server', f.origin])).code, 1);
  assert.equal(readFileSync(identityPath, 'utf8'), '{}');
  writeFileSync(identityPath, original); chmodSync(identityPath, 0o644);
  assert.equal((await f.run(['tags', '--server', f.origin])).code, 1);
  chmodSync(identityPath, 0o600); f.saveCredentials({ workspace_id: 'different-root' });
  assert.equal((await f.run(['tags', '--server', f.origin])).code, 1);
  assert.equal(f.state.requests.length, 0);
});

test('REQ-099 tags from root rules change subscription without reauthorization or lost progress', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, 'AGENTS.md'), '同步标签：work、中文；新增标签 new 需要补读。');
  const rules = readFileSync(join(f.workspace, 'AGENTS.md'), 'utf8');
  assert.ok(rules.includes('new')); // Agent reads prose and passes explicit arguments; CLI does not parse it.
  assert.equal((await f.init()).code, 0);
  assert.equal((await f.run(['sync', '--workspace', f.workspace])).code, 0);
  const id = f.workspaceState().subscription_id;
  const cursor = f.state.subscriptions.get(id).acknowledged_cursor;
  const credentials = readFileSync(f.credentialPath, 'utf8');
  for (const [labels, choice] of [['work,中文,new', 'yes'], ['work,new', undefined], ['work,new,other', 'no']]) {
    const args = ['set-tags', '--workspace', f.workspace, '--tags', labels];
    if (choice) args.push('--backfill', choice);
    assert.equal((await f.run(args)).code, 0);
    assert.equal(f.workspaceState().subscription_id, id);
    assert.equal(f.state.subscriptions.get(id).acknowledged_cursor, cursor);
  }
  assert.equal(readFileSync(f.credentialPath, 'utf8'), credentials);
  assert.equal(readFileSync(join(f.workspace, 'AGENTS.md'), 'utf8'), rules);
  assert.equal(f.state.requests.filter(request => request.path.startsWith('/oauth/')).length, 0);
  assert.equal(f.state.requests.filter(request => request.path.endsWith('/backfill')).length, 1);
});
