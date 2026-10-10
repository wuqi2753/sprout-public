// REQ-088–REQ-092: private, durable storage and crash-released process locks.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { object } from './contracts.js';

export const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function safePath(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('symbolic links are not allowed in CLI storage paths');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return absolute;
}
export function directory(path: string, privateDirectory = false): string {
  const absolute = safePath(path);
  const created: string[] = [];
  for (let current = absolute; !existsSync(current); current = dirname(current)) created.push(current);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || (privateDirectory && (stat.mode & 0o077) !== 0)) throw new Error('credential directory must be a private directory (0700)');
  for (const current of created.reverse()) { durableDirectory(current); durableDirectory(dirname(current)); }
  return absolute;
}
export function durableDirectory(path: string): void {
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function writeAtomic(path: string, contents: string | Uint8Array): void {
  safePath(path); const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); durableDirectory(dirname(path)); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function writeJSON(path: string, value: unknown): void { writeAtomic(path, JSON.stringify(value, null, 2) + '\n'); }
export function readJSON(path: string): Record<string, unknown> {
  safePath(path);
  if (!lstatSync(path).isFile() || lstatSync(path).size > 20 * 1024 * 1024) throw new Error('CLI state file has an invalid type or size');
  try { return object(JSON.parse(readFileSync(path, 'utf8')), 'stored JSON'); }
  catch { throw new Error('CLI state is corrupt; restore state or use init --rebuild'); }
}
export function inside(workspace: string, materialPath: string): string {
  if (isAbsolute(materialPath)) throw new Error('materials must be a relative workspace path');
  const destination = safePath(resolve(workspace, materialPath));
  const part = relative(workspace, destination);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || part === '.sprout' || part.startsWith(`.sprout${sep}`)) throw new Error('materials must be inside the workspace and outside .sprout');
  return destination;
}
export class StorageBusy extends Error {
  constructor() { super('workspace or credentials are currently in use; retry after the running command exits'); }
}
export async function locked<T>(path: string, action: () => Promise<T>): Promise<T> {
  safePath(path);
  const database = new DatabaseSync(path);
  try {
    try { database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch (error) {
      if ((error as { errcode?: number }).errcode === 5) throw new StorageBusy();
      throw error;
    }
    return await action();
  } finally { database.close(); }
}
export function removeDurable(path: string): void { safePath(path); unlinkSync(path); durableDirectory(dirname(path)); }
