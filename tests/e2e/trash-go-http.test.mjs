import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

const binary = process.env.SPROUT_TEST_SERVER_BINARY;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('REQ-065 real local Go HTTP: trash, restore, purge, clear, restart and attachment cleanup', { skip: !binary }, async (t) => {
  const testDirectory = join(globalThis.process.cwd(), '.tmp');
  mkdirSync(testDirectory, { recursive: true });
  const directory = mkdtempSync(join(testDirectory, 'sprout-trash-go-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'notes.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let process;
  async function start() {
    process = spawn(binary, [], {
      cwd: directory,
      env: { ...processEnv(), SPROUT_LISTEN_ADDRESS: `127.0.0.1:${port}`, SPROUT_API_KEY: 'trash-e2e-key', SPROUT_DATABASE_PATH: databasePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    process.stdout.on('data', (chunk) => { output += chunk.toString(); });
    process.stderr.on('data', (chunk) => { output += chunk.toString(); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (process.exitCode !== null) throw new Error(`Go Server exited: ${output}`);
      try {
        const response = await fetch(`${base}/api/v1/health`, { headers: { Authorization: 'Bearer trash-e2e-key' }, signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Go Server did not start: ${output}`);
  }
  async function stop() {
    if (!process || process.exitCode !== null) return;
    const stopped = new Promise((resolve) => process.once('close', resolve));
    process.kill('SIGTERM');
    await stopped;
  }
  t.after(stop);
  await start();
  async function request(method, path, body, operationId, authorization = 'Bearer trash-e2e-key') {
    const response = await fetch(base + path, { method, headers: {
      Authorization: authorization,
      ...(operationId ? { 'Idempotency-Key': operationId } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const id = '018f4b64-8be1-7ee2-b608-9d26c750f57a';
  const secondId = '018f4b64-8be1-7ee2-b608-9d26c750f57b';
  const imageId = `${id}:0`;
  const fileId = `${secondId}:file`;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1]);
  const upload = await fetch(`${base}/api/v1/objects/${imageId}`, { method: 'PUT',
    headers: { Authorization: 'Bearer trash-e2e-key', 'Content-Type': 'image/png' }, body: png });
  assert.equal(upload.status, 201);
  const create = await request('POST', '/api/v1/notes', { note_id: id, content: '回收站测试', images: [imageId], created_at: '2026-10-01T00:00:00Z' }, '0199a633-67aa-7e58-97f8-0196e3684b91');
  assert.equal(create.status, 201);
  const pdf = Buffer.from('%PDF-1.4\n');
  const fileUpload = await fetch(`${base}/api/v1/files/${fileId}`, { method: 'PUT',
    headers: { Authorization: 'Bearer trash-e2e-key', 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('note.pdf'),
      'X-File-SHA256': createHash('sha256').update(pdf).digest('hex') }, body: pdf });
  assert.equal(fileUpload.status, 201);
  const createSecond = await request('POST', '/api/v1/notes', { note_id: secondId, content: '保留正常笔记', files: [fileId], created_at: '2026-10-02T00:00:00Z' }, '0199a633-67aa-7e58-97f8-0196e3684b92');
  assert.equal(createSecond.status, 201);
  const denied = await request('GET', '/api/v1/trash', undefined, undefined, 'Bearer wrong');
  assert.equal(denied.status, 401);
  const deleted = await request('DELETE', `/api/v1/notes/${id}`, { base_version: 1 }, '0199a633-67aa-7e58-97f8-0196e3684b93');
  assert.equal(deleted.status, 200);
  assert.equal(new Date(deleted.body.expires_at).getTime() - new Date(deleted.body.deleted_at).getTime(), 30 * 86400_000);
  const repeated = await request('DELETE', `/api/v1/notes/${id}`, { base_version: 1 }, '0199a633-67aa-7e58-97f8-0196e3684b93');
  assert.deepEqual(repeated.body, deleted.body);
  assert.deepEqual((await request('GET', '/api/v1/notes')).body.notes.map((memo) => memo.note_id), [secondId]);
  assert.deepEqual((await request('GET', '/api/v1/trash')).body.notes.map((memo) => memo.note_id), [id]);
  await stop();
  await start();
  assert.deepEqual((await request('GET', '/api/v1/trash')).body.notes.map((memo) => memo.note_id), [id]);
  const restored = await request('POST', `/api/v1/notes/${id}/restore`, { base_version: 2 }, '0199a633-67aa-7e58-97f8-0196e3684b94');
  assert.equal(restored.status, 200);
  assert.equal(restored.body.version, 3);
  assert.equal(restored.body.deleted_at, null);
  assert.deepEqual(restored.body.images, [imageId]);
  assert.equal((await request('POST', `/api/v1/notes/${id}/restore`, { base_version: 2 }, '0199a633-67aa-7e58-97f8-0196e3684b94')).body.version, 3);
  assert.equal((await request('DELETE', `/api/v1/notes/${id}`, { base_version: 3 }, '0199a633-67aa-7e58-97f8-0196e3684b95')).status, 200);
  const purged = await request('POST', `/api/v1/notes/${id}/purge`, { base_version: 4 }, '0199a633-67aa-7e58-97f8-0196e3684b96');
  assert.equal(purged.status, 200);
  assert.equal((await request('GET', `/api/v1/notes/${id}`)).status, 404);
  const removedImage = await fetch(`${base}/api/v1/objects/${imageId}`, { headers: { Authorization: 'Bearer trash-e2e-key' } });
  assert.equal(removedImage.status, 404);
  assert.deepEqual((await request('GET', '/api/v1/notes')).body.notes.map((memo) => memo.note_id), [secondId]);
  assert.equal((await request('DELETE', `/api/v1/notes/${secondId}`, { base_version: 1 }, '0199a633-67aa-7e58-97f8-0196e3684b97')).status, 200);
  const restoredFileNote = await request('POST', `/api/v1/notes/${secondId}/restore`, { base_version: 2 }, '0199a633-67aa-7e58-97f8-0196e3684b99');
  assert.equal(restoredFileNote.status, 200);
  assert.deepEqual(restoredFileNote.body.files, [fileId]);
  const retainedFile = await fetch(`${base}/api/v1/files/${fileId}`, { headers: { Authorization: 'Bearer trash-e2e-key' } });
  assert.equal(retainedFile.status, 200);
  assert.deepEqual(Buffer.from(await retainedFile.arrayBuffer()), pdf);
  assert.equal((await request('DELETE', `/api/v1/notes/${secondId}`, { base_version: 3 }, '0199a633-67aa-7e58-97f8-0196e3684b9a')).status, 200);
  const cleared = await request('POST', '/api/v1/trash', {}, '0199a633-67aa-7e58-97f8-0196e3684b98');
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.purged, 1);
  assert.deepEqual((await request('GET', '/api/v1/trash')).body.notes, []);
  const removedFile = await fetch(`${base}/api/v1/files/${fileId}`, { headers: { Authorization: 'Bearer trash-e2e-key' } });
  assert.equal(removedFile.status, 404);
  const directId = '018f4b64-8be1-7ee2-b608-9d26c750f584';
  const directImageId = `${directId}:0`;
  const directUpload = await fetch(`${base}/api/v1/objects/${directImageId}`, { method: 'PUT',
    headers: { Authorization: 'Bearer trash-e2e-key', 'Content-Type': 'image/png' }, body: png });
  assert.equal(directUpload.status, 201);
  assert.equal((await request('POST', '/api/v1/notes', { note_id: directId, content: 'hidden direct delete', images: [directImageId], created_at: '2026-10-03T00:00:00Z' }, '0199a633-67aa-7e58-97f8-0196e3684b9b')).status, 201);
  const directPurge = await request('POST', `/api/v1/notes/${directId}/purge`, { base_version: 1 }, '0199a633-67aa-7e58-97f8-0196e3684b9c');
  assert.equal(directPurge.status, 200);
  assert.equal(directPurge.body.deleted_at, null);
  assert.deepEqual((await request('GET', '/api/v1/trash')).body.notes, []);
  assert.deepEqual((await request('GET', '/api/v1/notes')).body.notes, []);
  assert.equal((await fetch(`${base}/api/v1/objects/${directImageId}`, { headers: { Authorization: 'Bearer trash-e2e-key' } })).status, 404);
  assert.deepEqual((await request('POST', `/api/v1/notes/${directId}/purge`, { base_version: 1 }, '0199a633-67aa-7e58-97f8-0196e3684b9c')).body, directPurge.body);
});

function processEnv() { return globalThis.process.env; }
