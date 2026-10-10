// REQ-094: validate the distributed artifact, not the source checkout entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cliRoot, fixture, hash, makeNote, upsert } from './support.mjs';

async function execute(command, args, cwd, env = {}) {
  const running = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  running.stdout.on('data', bytes => { stdout += bytes; });
  running.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { running.once('error', reject); running.once('close', resolve); });
  assert.equal(code, 0, `${command} ${args.join(' ')}\n${stderr}\n${stdout}`);
  return stdout;
}

test('REQ-094 tarball allowlist, installed bin, npx and independent workspace synchronization', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const cache = join(f.root, 'npm-cache');
  const prefix = join(f.root, 'installation');
  const npmEnv = { npm_config_cache: cache, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  const packed = JSON.parse(await execute('npm', ['pack', '--json', '--pack-destination', f.root], cliRoot, npmEnv))[0];
  const tarball = join(f.root, packed.filename);
  const filenames = packed.files.map(file => file.path).sort();
  const expected = ['package.json', 'README.md', 'PROTOCOL.md', ...readdirSync(join(cliRoot, 'src')).map(name => `dist/${name.replace(/\.ts$/, '.js')}`)].sort();
  assert.deepEqual(filenames, expected);
  const unpacked = join(f.root, 'unpacked'); mkdirSync(unpacked);
  await execute('tar', ['-xzf', tarball, '-C', unpacked], f.root);
  const manifest = JSON.parse(readFileSync(join(unpacked, 'package/package.json')));
  assert.equal(manifest.name, '@sprout-native/cli');
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.engines.node, '>=22.14.0');
  assert.deepEqual(manifest.os, ['darwin', 'linux']);
  assert.equal(manifest.bin.sprout, 'dist/main.js');
  for (const filename of filenames) {
    const content = readFileSync(join(unpacked, 'package', filename), 'utf8');
    assert.doesNotMatch(content, /\/Users\/|\/home\/|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|private-device|access-1|refresh-1/);
    if (filename.startsWith('dist/')) assert.equal(content, readFileSync(join(cliRoot, filename), 'utf8'));
  }
  await execute('npm', ['install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', tarball], f.root, npmEnv);
  const executable = join(prefix, 'bin/sprout');
  const cliEnv = { ...npmEnv, SPROUT_CLI_CONFIG_DIR: f.credentials };
  const run = args => execute(executable, args, f.root, cliEnv);
  assert.match(await run(['--help']), /sprout/);
  assert.equal((await run(['--version'])).trim(), manifest.version);
  assert.equal(JSON.parse(await run(['describe', '--json'])).ok, true);
  assert.equal((await execute('npx', ['--offline', '--yes', `--package=${tarball}`, 'sprout', '--version'], f.root, cliEnv)).trim(), manifest.version);
  const second = join(f.root, 'second-workspace'); mkdirSync(second);
  f.saveWorkspaceCredentials(second);
  for (const [workspace, tag, receipt] of [[f.workspace, 'work', 'first-progress'], [second, '中文', 'second-progress']]) {
    await run(['init', '--server', f.origin, '--workspace', workspace, '--tags', tag, '--materials', 'materials']);
    f.state.pages = [{ receipt, phase: 'initial', done: true, items: [upsert(makeNote(receipt, `#${tag} isolated`))] }];
    await run(['sync', '--workspace', workspace]);
    assert.equal(readFileSync(join(workspace, 'materials', hash(receipt) + '.md'), 'utf8'), `#${tag} isolated`);
  }
  const firstState = f.workspaceState();
  const secondState = JSON.parse(readFileSync(join(second, '.sprout/workspace.json')));
  assert.notEqual(firstState.subscription_id, secondState.subscription_id);
  assert.deepEqual(firstState.tags, ['work']); assert.deepEqual(secondState.tags, ['中文']);
  assert.equal(f.state.subscriptions.get(firstState.subscription_id).acknowledged_cursor, 'first-progress');
  assert.equal(f.state.subscriptions.get(secondState.subscription_id).acknowledged_cursor, 'second-progress');
  assert.deepEqual(Object.keys(f.index().notes), ['first-progress']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(second, 'materials/index.json'))).notes), ['second-progress']);
  assert.equal(f.state.requests.filter(request => request.path.endsWith('/ack')).length, 2);
  f.state.pages = [{ receipt: 'first-incremental', phase: 'incremental', done: true, items: [upsert(makeNote('first-progress', '#work updated', [], [], 2))] }];
  await run(['sync', '--workspace', f.workspace]);
  assert.equal(readFileSync(join(f.workspace, 'materials', hash('first-progress') + '.md'), 'utf8'), '#work updated');
  assert.equal(f.state.subscriptions.get(firstState.subscription_id).acknowledged_cursor, 'first-incremental');
  assert.equal(f.state.subscriptions.get(secondState.subscription_id).acknowledged_cursor, 'second-progress');
  assert.equal(readFileSync(join(second, 'materials', hash('second-progress') + '.md'), 'utf8'), '#中文 isolated');
  t.diagnostic(JSON.stringify({ node: process.version, package: manifest.name, version: manifest.version, files: filenames, bytes: packed.size, unpackedBytes: packed.unpackedSize, server: 'loopback fixture; direct installed CLI HTTP requests', publicPublish: false }));
});
