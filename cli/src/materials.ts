// REQ-090/REQ-091: only write owned bytes, retain stop notifications and all attachments.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { object, page, receipt, string, strings, type Item } from './contracts.js';
import { digest, readJSON, safePath, writeAtomic, writeJSON } from './disk.js';
import { Client } from './http.js';
import { WorkspaceStore, type Workspace } from './workspace.js';

type MaterialIndex = { schema: 1; notes: Record<string, Record<string, unknown>>; owned_files: Record<string, string[]> };
export class Materials {
  readonly root: string; readonly indexPath: string; readonly index: MaterialIndex;
  constructor(readonly store: WorkspaceStore, readonly state: Workspace) {
    if (!state.material_ready) throw new Error('material setup is unfinished; retry init');
    this.root = store.path(state); this.indexPath = join(this.root, 'index.json');
    if (!existsSync(join(this.root, '.sprout-owner.json')) || !existsSync(this.indexPath)) throw new Error('local materials are missing; use init --rebuild with a new materials directory');
    const marker = readJSON(join(this.root, '.sprout-owner.json'));
    if (marker.subscription_id !== state.subscription_id || marker.creation_key !== state.creation_key) throw new Error('material ownership marker mismatch');
    const saved = readJSON(this.indexPath);
    if (saved.schema !== 1) throw new Error('unsupported material index schema');
    const notes = object(saved.notes, 'index.notes'); const owned = object(saved.owned_files, 'index.owned_files');
    this.index = { schema: 1, notes: Object.create(null), owned_files: Object.create(null) };
    for (const [id, value] of Object.entries(notes)) this.index.notes[id] = object(value, 'indexed note');
    for (const [filename, hashes] of Object.entries(owned)) {
      if (!/^[a-f0-9]{64}\.(json|md|bin)$/.test(filename)) throw new Error('invalid material filename in index');
      const validated = strings(hashes, 'owned hashes');
      if (!validated.length || validated.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('invalid material hash in index');
      this.index.owned_files[filename] = validated;
    }
    this.verifyFiles();
  }
  private save(): void { writeJSON(this.indexPath, this.index); }
  private verifyFiles(): void {
    for (const [filename, hashes] of Object.entries(this.index.owned_files)) {
      const path = safePath(join(this.root, filename));
      // Two hashes mean an interrupted write; a single committed hash must exist.
      if (!existsSync(path)) { if (hashes.length === 1) throw new Error('local materials are missing; use init --rebuild'); continue; }
      if (!hashes.includes(digest(readFileSync(path)))) throw new Error('material was edited outside CLI; preserve it and rebuild into a new directory');
    }
  }
  private writeOwned(filename: string, bytes: string | Uint8Array): void {
    const path = safePath(join(this.root, filename)); const hash = digest(bytes); const owned = this.index.owned_files[filename];
    if (existsSync(path)) {
      if (!owned || !owned.includes(digest(readFileSync(path)))) throw new Error('refusing to overwrite an unowned or modified material file');
    } else if (owned?.length === 1) throw new Error('local material is missing; use init --rebuild');
    // Reservation survives crashes before file creation or rename. Empty string marks a reserved, absent file.
    this.index.owned_files[filename] = [...new Set([...(owned ?? []), hash, ...(owned ? [] : ['0'.repeat(64)])])];
    this.save(); writeAtomic(path, bytes); this.index.owned_files[filename] = [hash]; this.save();
  }
  async apply(client: Client, item: Item): Promise<void> {
    if (item.action === 'stop') {
      const existing = this.index.notes[item.note_id];
      if (existing) { existing.updating = false; this.save(); }
      return;
    }
    const note = item.note; const attachments: Record<string, string> = {};
    for (const [kind, ids] of [['objects', note.images], ['files', note.files]] as const) {
      for (const id of ids) {
        const bytes = await client.request(`/api/v1/${kind}/${encodeURIComponent(id)}`, undefined, false, true) as Uint8Array;
        if (!bytes.length) throw new Error('attachment download returned no bytes');
        const filename = digest(bytes) + '.bin'; this.writeOwned(filename, bytes); attachments[id] = filename;
      }
    }
    const filename = digest(note.note_id);
    this.writeOwned(filename + '.json', JSON.stringify(note, null, 2) + '\n');
    this.writeOwned(filename + '.md', note.content);
    this.index.notes[note.note_id] = { note_id: note.note_id, version: note.version, updating: true, note: filename + '.json', content: filename + '.md', attachments };
    this.save();
  }
}
export async function sync(client: Client, store: WorkspaceStore, state: Workspace) {
  if (state.tag_change) throw new Error('unfinished tag change; retry set-tags before sync');
  const materials = new Materials(store, state);
  let pages = 0;
  while (true) {
    if (client.signal.aborted) throw new Error('sync interrupted');
    if (!state.pending_ack) {
      const result = page(await client.request(store.endpoint(state, '/pull'), { limit: 50 }));
      for (const item of result.items) await materials.apply(client, item);
      state.pending_ack = receipt(result); store.save(state);
    }
    const pending = state.pending_ack;
    const acknowledged = object(await client.request(store.endpoint(state, '/ack'), { receipt: pending.receipt }), 'ack');
    if (string(acknowledged.subscription_id, 'ack.subscription_id') !== state.subscription_id) throw new Error('ack subscription_id mismatch');
    delete state.pending_ack; store.save(state); pages++;
    if (pending.done && pending.phase !== 'backfill') break;
  }
  return { pages_acknowledged: pages, notes_known: Object.keys(materials.index.notes).length, materials: state.materials, index: state.materials + '/index.json' };
}
