// REQ-073/074: Go binary -> PNG/terminal -> independent ZXing decoder -> App parser.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const temporaryRoot = join(root, '.tmp');
mkdirSync(temporaryRoot, { recursive: true });

function appParser() {
  function compile(filename, dependencies = {}) {
    const source = readFileSync(join(root, 'src/api', `${filename}.ts`), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    vm.runInNewContext(`(function(require, exports) { ${compiled} })`, { URL, Date })((name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`);
      return dependencies[name];
    }, exports);
    return exports;
  }
  return compile('server-qr', { './server-connection': compile('server-connection') }).parseServerQr;
}

test('Go connection QR roundtrip, config isolation and command failures', async (t) => {
  const directory = mkdtempSync(join(temporaryRoot, 'connection-qr-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const localGo = join(temporaryRoot, 'go124/go/bin/go');
  const go = process.env.SPROUT_GO_BINARY ?? (existsSync(localGo) ? localGo : 'go');
  const binary = join(directory, 'sprout-server');
  const build = spawnSync(go, ['build', '-o', binary, '.'], {
    cwd: join(root, 'server'), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GOCACHE: join(temporaryRoot, 'go-cache'), GOPATH: join(temporaryRoot, 'go-path'), GOTMPDIR: directory, TMPDIR: directory },
  });
  assert.equal(build.status, 0, build.error?.message ?? build.stderr);
  await prepareZXingModule({ overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')) }, fireImmediately: true });
  const parse = appParser();
  const configPath = join(directory, '.env');
  const databasePath = join(directory, 'must-not-create.db');
  const pngPath = join(directory, 'connection.png');
  const key = 'fixture-"quote\\backslash-key';
  const configuration = `# fixture\nSPROUT_API_KEY='${key}'\nSPROUT_DATABASE_PATH=${databasePath}\nSPROUT_LISTEN_ADDRESS=127.0.0.1:8080\n`;
  writeFileSync(configPath, configuration, { mode: 0o600 });
  function command(args) {
    return spawnSync(binary, args, { cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, SPROUT_API_KEY: 'must-not-override-file-key' } });
  }
  const png = command(['-connection-qr', 'https://memo.example.com/', '-qr-output', pngPath]);
  assert.equal(png.status, 0, png.stderr);
  assert.equal(png.stdout, '');
  assert.equal(statSync(pngPath).mode & 0o777, 0o600);
  const image = readFileSync(pngPath);
  const decoded = await readBarcodes(image, { formats: ['QRCode'] });
  assert.equal(decoded.length, 1);
  const scanned = parse(decoded[0].text);
  assert.equal(scanned.serverUrl, 'https://memo.example.com');
  assert.equal(scanned.apiKey, key);
  assert.equal(scanned.type, 'pairing');

  // Reconstruct terminal half-blocks as an image and decode that output too.
  const terminal = command(['-env-file', configPath, '-connection-qr', 'https://memo.example.com']);
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.equal(terminal.stdout.includes(key), false);
  const lines = terminal.stdout.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split('\n');
  const rows = lines.map((line) => Array.from(line));
  const width = rows[0].length;
  const height = rows.length * 2;
  const scale = 8;
  const rgba = new Uint8ClampedArray(width * scale * height * scale * 4);
  for (let y = 0; y < height * scale; y++) for (let x = 0; x < width * scale; x++) {
    const glyph = rows[Math.floor(y / (2 * scale))][Math.floor(x / scale)] ?? ' ';
    const lower = Math.floor(y / scale) % 2 === 1;
    const black = glyph === '█' || glyph === (lower ? '▄' : '▀');
    const offset = (y * width * scale + x) * 4;
    rgba.set([black ? 0 : 255, black ? 0 : 255, black ? 0 : 255, 255], offset);
  }
  const terminalDecoded = await readBarcodes({ data: rgba, width: width * scale, height: height * scale }, { formats: ['QRCode'] });
  assert.equal(terminalDecoded.length, 1);
  assert.equal(parse(terminalDecoded[0].text).apiKey, key);
  assert.equal(readFileSync(configPath, 'utf8'), configuration);
  assert.equal(existsSync(databasePath), false);
  const repeat = command(['-connection-qr', 'https://memo.example.com', '-qr-output', pngPath]);
  assert.notEqual(repeat.status, 0);
  assert.deepEqual(readFileSync(pngPath), image);
  for (const args of [
    ['-connection-qr', 'https://memo.example.com:8080'],
    ['-connection-qr', 'https://memo.example.com/api/v1'],
    ['-connection-qr', ['https:', '//user:secret', '@', 'memo.example.com'].join('')],
    ['-connection-qr', ''],
    ['-connection-qr', 'https://memo.example.com', '-env-file', join(directory, 'missing.env')],
    ['-qr-output', join(directory, 'invalid.png')],
  ]) {
    const failure = command(args);
    assert.notEqual(failure.status, 0);
    assert.equal(failure.stdout, '');
    assert.equal(failure.stderr.includes(key), false);
    assert.equal(failure.stderr.includes('user:secret'), false);
  }
  for (const invalidConfig of ['', 'SPROUT_API_KEY=\n', 'SPROUT_API_KEY=first\nSPROUT_API_KEY=second\n', 'SPROUT_API_KEY=private key\n']) {
    writeFileSync(configPath, invalidConfig);
    const failure = command(['-connection-qr', 'https://memo.example.com']);
    assert.notEqual(failure.status, 0);
    assert.equal(failure.stdout, '');
    assert.equal(failure.stderr.includes('private key'), false);
  }
});
