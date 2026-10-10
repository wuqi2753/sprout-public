// REQ-089–REQ-092: persistent intent before requests; Server owns cursors.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { object, receipt, sameTags, serverURL, string, subscription, tags, type Receipt } from './contracts.js';
import { digest, directory, inside, locked, readJSON, safePath, writeJSON } from './disk.js';
import { Client } from './http.js';
import { CommandFailure } from './errors.js';

type TagChange = { request_id: string; expected_tags: string[]; tags: string[]; backfill: boolean };
export type Workspace = { schema: 1; server: string; creation_key: string; subscription_id?: string; tags: string[]; materials: string; material_ready: boolean; pending_ack?: Receipt; tag_change?: TagChange };
export class WorkspaceStore {
  readonly root: string; readonly statePath: string; readonly workspace: string;
  constructor(path: string) {
    const requestedRoot = safePath(path);
    if (!existsSync(requestedRoot) || !lstatSync(requestedRoot).isDirectory()) throw new Error('workspace must already exist as a directory');
    this.workspace = realpathSync(requestedRoot);
    this.root = directory(join(this.workspace, '.sprout')); this.statePath = join(this.root, 'workspace.json');
  }
  async run<T>(action: () => Promise<T>): Promise<T> { return locked(join(this.root, 'lock.sqlite'), action); }
  // REQ-099: call under the workspace lock; copied roots cannot reuse local authorization.
  identity(): string {
    const identityPath = join(this.root, 'identity.json');
    const rootHash = digest(this.workspace);
    if (existsSync(identityPath)) {
      safePath(identityPath);
      if ((lstatSync(identityPath).mode & 0o077) !== 0) throw new Error('workspace identity file permissions must be 0600');
      const saved = readJSON(identityPath);
      if (saved.schema !== 1 || typeof saved.workspace_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(saved.workspace_id) || typeof saved.root_hash !== 'string' || !/^[a-f0-9]{64}$/.test(saved.root_hash)) throw new Error('workspace identity is invalid; restore its valid configuration');
      if (saved.root_hash === rootHash) return saved.workspace_id;
    }
    const workspaceId = randomUUID();
    writeJSON(identityPath, { schema: 1, workspace_id: workspaceId, root_hash: rootHash });
    return workspaceId;
  }
  read(): Workspace {
    if (!existsSync(this.statePath)) throw new Error('workspace is not initialized; run init');
    const saved = readJSON(this.statePath);
    if (saved.schema !== 1) throw new Error('unsupported workspace schema');
    if (typeof saved.material_ready !== 'boolean') throw new Error('workspace material_ready must be boolean');
    const result: Workspace = { schema: 1, server: serverURL(saved.server), creation_key: string(saved.creation_key, 'creation_key'), tags: tags(saved.tags), materials: string(saved.materials, 'materials'), material_ready: saved.material_ready };
    inside(this.workspace, result.materials);
    if (saved.subscription_id !== undefined) result.subscription_id = string(saved.subscription_id, 'subscription_id');
    if (saved.pending_ack !== undefined) result.pending_ack = receipt(saved.pending_ack);
    if (saved.tag_change !== undefined) {
      const change = object(saved.tag_change, 'tag_change');
      if (typeof change.backfill !== 'boolean') throw new Error('tag_change.backfill must be boolean');
      result.tag_change = { request_id: string(change.request_id, 'request_id'), expected_tags: tags(change.expected_tags), tags: tags(change.tags), backfill: change.backfill };
    }
    return result;
  }
  save(state: Workspace): void { writeJSON(this.statePath, state); }
  path(state: Workspace): string { return inside(this.workspace, state.materials); }
  endpoint(state: Workspace, suffix = ''): string {
    if (!state.subscription_id) throw new Error('subscription creation is unfinished; retry init with original arguments');
    return `/api/v1/subscriptions/${encodeURIComponent(state.subscription_id)}${suffix}`;
  }
  async init(client: Client, labels: string[], materials: string, rebuild: boolean): Promise<Workspace> {
    let state: Workspace;
    const destination = inside(this.workspace, materials);
    if (existsSync(this.statePath) && !rebuild) {
      state = this.read();
      if (state.server !== client.server || !sameTags(state.tags, labels) || state.materials !== materials) throw new Error('workspace already configured differently; use init --rebuild with a new materials directory');
      if (state.subscription_id) {
        if (!state.material_ready) { this.prepareMaterials(state); state.material_ready = true; this.save(state); }
        return state;
      }
    } else {
      if (existsSync(destination)) throw new Error('new materials directory must not already exist');
      state = { schema: 1, server: client.server, creation_key: randomUUID(), tags: labels, materials, material_ready: false };
      this.save(state);
    }
    const created = subscription(await client.request('/api/v1/subscriptions', { tags: state.tags, creation_key: state.creation_key }));
    if (!sameTags(created.tags, state.tags)) throw new Error('Server created a subscription with unexpected tags');
    state.subscription_id = created.subscription_id;
    // Persist the ID before material setup so setup can be recovered without creating another subscription.
    this.save(state); this.prepareMaterials(state); state.material_ready = true; this.save(state); return state;
  }
  prepareMaterials(state: Workspace): void {
    const destination = this.path(state);
    if (!existsSync(destination)) {
      directory(destination);
    }
    const marker = join(destination, '.sprout-owner.json');
    if (existsSync(marker)) {
      const owner = readJSON(marker);
      if (owner.creation_key !== state.creation_key || owner.subscription_id !== state.subscription_id) throw new Error('materials belong to a different subscription');
    } else {
      // Initialization may recover a crash between mkdir and marker write; reject any existing material.
      if (readdirSync(destination).length) throw new Error('unowned materials directory is not empty; use a new directory with init --rebuild');
      writeJSON(marker, { creation_key: state.creation_key, subscription_id: state.subscription_id });
    }
    const index = join(destination, 'index.json');
    if (!existsSync(index)) writeJSON(index, { schema: 1, notes: {}, owned_files: {} });
  }
  async changeTags(client: Client, state: Workspace, labels: string[], choice?: string): Promise<void> {
    if (state.pending_ack) throw new Error('finish sync before changing tags');
    const added = labels.filter((label) => !state.tags.includes(label));
    if (!state.tag_change && sameTags(state.tags, labels)) return;
    if (!state.tag_change && added.length && choice === undefined) throw new CommandFailure('INPUT_REQUIRED', 'new tags require an explicit --backfill yes or no choice', 'Ask the user whether to backfill existing materials, then retry with their explicit choice.');
    if (state.tag_change && (!sameTags(state.tag_change.tags, labels) || (choice !== undefined && state.tag_change.backfill !== (choice === 'yes')))) throw new Error('unfinished tag change; retry the original tags and backfill choice');
    state.tag_change ??= { request_id: randomUUID(), expected_tags: state.tags, tags: labels, backfill: added.length > 0 && choice === 'yes' };
    this.save(state);
    const change = state.tag_change;
    const updated = subscription(await client.patch(this.endpoint(state), { tags: change.tags, expected_tags: change.expected_tags, request_id: change.request_id }));
    if (updated.subscription_id !== state.subscription_id || !sameTags(updated.tags, labels)) throw new Error('Server returned an unexpected subscription after tag change');
    if (change.backfill) {
      const result = object(await client.request(this.endpoint(state, '/backfill'), { tags: change.tags.filter((label) => !change.expected_tags.includes(label)), request_id: change.request_id }), 'backfill');
      if (result.subscription_id !== state.subscription_id) throw new Error('backfill subscription_id mismatch');
    }
    state.tags = change.tags; delete state.tag_change; this.save(state);
  }
}
