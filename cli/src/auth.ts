// REQ-088: Device Flow, rotation journal and retryable revocation.
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { integer, object, serverURL, string } from './contracts.js';
import { digest, directory, locked, readJSON, removeDurable, StorageBusy, writeJSON } from './disk.js';
import { Client, HTTPFailure } from './http.js';
import { CommandFailure } from './errors.js';

type Credentials = { server: string; workspace_id: string; access_token: string; refresh_token: string; expires_at: number; uncertain: boolean };
function credentials(value: unknown, server: string, workspaceId: string): Credentials {
  const saved = object(value, 'credentials');
  if (saved.server !== server || saved.workspace_id !== workspaceId || typeof saved.uncertain !== 'boolean') throw new Error('stored credential state is invalid for this workspace; login again');
  return { server, workspace_id: workspaceId, access_token: string(saved.access_token, 'access_token'), refresh_token: string(saved.refresh_token, 'refresh_token'), expires_at: integer(saved.expires_at, 'expires_at'), uncertain: saved.uncertain };
}
function tokens(value: unknown, server: string, workspaceId: string): Credentials {
  const issued = object(value, 'tokens');
  if (issued.token_type !== 'Bearer' || issued.scope !== 'notes:read subscriptions:manage') throw new Error('Server returned unsupported token type or scope');
  return { server, workspace_id: workspaceId, access_token: string(issued.access_token, 'access_token'), refresh_token: string(issued.refresh_token, 'refresh_token'), expires_at: Date.now() + integer(issued.expires_in, 'expires_in') * 1000, uncertain: false };
}
export class Auth {
  readonly root: string;
  readonly file: string;
  readonly client: Client;
  constructor(readonly server: string, readonly signal: AbortSignal, readonly workspaceId: string) {
    if (process.platform === 'win32') throw new Error('CLI credential storage currently supports macOS and Linux only');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(workspaceId)) throw new Error('workspace_id must be a UUID');
    const configRoot = directory(process.env.SPROUT_CLI_CONFIG_DIR ?? join(homedir(), '.config', 'sprout-cli'), true);
    this.root = directory(join(configRoot, 'workspaces', workspaceId), true);
    this.file = join(this.root, digest(server) + '.json'); this.client = new Client(server, signal);
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 31000;
    while (true) {
      try { return await locked(join(this.root, digest(this.server) + '.lock.sqlite'), action); }
      catch (error) {
        if (!(error instanceof StorageBusy) || Date.now() >= deadline) throw error;
        await delay(50, undefined, { signal: this.signal });
      }
    }
  }
  private load(): Credentials {
    if (!existsSync(this.file)) throw new CommandFailure('AUTH_REQUIRED', 'this workspace is not logged in', 'Run login --server URL --workspace ROOT, then ask the user to approve in their App.');
    directory(this.root, true);
    // Validate the path before inspecting or reading any secret file.
    if (lstatSync(this.file).isSymbolicLink()) throw new Error('symbolic links are not allowed in CLI credential paths');
    if ((lstatSync(this.file).mode & 0o077) !== 0) throw new Error('credential file permissions must be 0600');
    return credentials(readJSON(this.file), this.server, this.workspaceId);
  }
  private form(fields: Record<string, string>): URLSearchParams { return new URLSearchParams({ client_id: 'sprout-cli', ...fields }); }
  async login(output: (event: { event: 'authorization_required'; verification_uri: string; user_code: string; expires_in: number }) => void): Promise<void> {
    // Revoke an existing grant before replacing it; history tokens can revoke uncertain refreshes.
    if (existsSync(this.file)) await this.logout();
    const issued = object(await this.client.request('/oauth/device_authorization', this.form({}), true), 'device authorization');
    const device = string(issued.device_code, 'device_code'); const code = string(issued.user_code, 'user_code');
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw new Error('Server returned invalid user_code');
    const uri = new URL(string(issued.verification_uri_complete, 'verification_uri_complete'));
    if (serverURL(uri.origin) !== this.server || uri.pathname !== '/oauth/device' || uri.username || uri.password || uri.hash || uri.search !== `?user_code=${code}`) throw new Error('Server returned an untrusted verification URL');
    let interval = integer(issued.interval, 'interval'); const expires = integer(issued.expires_in, 'expires_in');
    if (interval < 5 || interval > 60 || expires > 600) throw new Error('Server returned invalid Device Flow timing');
    const deadline = Date.now() + expires * 1000;
    output({ event: 'authorization_required', verification_uri: uri.href, user_code: code, expires_in: expires });
    while (Date.now() < deadline) {
      await delay(Math.min(interval * 1000, deadline - Date.now()), undefined, { signal: this.signal });
      if (Date.now() >= deadline) break;
      try {
        const saved = tokens(await this.client.request('/oauth/token', this.form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device }), true), this.server, this.workspaceId);
        try { writeJSON(this.file, saved); }
        catch {
          await this.client.request('/oauth/revoke', this.form({ token: saved.refresh_token }), true);
          throw new Error('credential storage failed; issued grant revoked, login again');
        }
        return;
      } catch (error) {
        if (error instanceof HTTPFailure && error.code === 'authorization_pending') continue;
        if (error instanceof HTTPFailure && error.code === 'slow_down') { interval += 5; continue; }
        throw error;
      }
    }
    throw new Error('device authorization expired; login again');
  }
  async access(): Promise<string> {
    return this.run(() => this.rotateIfNeeded());
  }
  private async rotateIfNeeded(): Promise<string> {
    const saved = this.load();
    if (saved.uncertain) throw new CommandFailure('AUTH_UNCERTAIN', 'previous token refresh outcome is uncertain', 'Run login again; never replay the old Refresh Token.');
    if (saved.expires_at > Date.now() + 30000) return saved.access_token;
    writeJSON(this.file, { ...saved, uncertain: true });
    try {
      const rotated = tokens(await this.client.request('/oauth/token', this.form({ grant_type: 'refresh_token', refresh_token: saved.refresh_token }), true), this.server, this.workspaceId);
      writeJSON(this.file, rotated);
      return rotated.access_token;
    } catch { throw new CommandFailure('AUTH_UNCERTAIN', 'token refresh failed or its outcome is uncertain', 'Run login again; never replay the old Refresh Token.'); }
  }
  async logout(): Promise<void> {
    const saved = this.load();
    await this.client.request('/oauth/revoke', this.form({ token: saved.refresh_token, token_type_hint: 'refresh_token' }), true);
    removeDurable(this.file);
  }
  business(): Client { return new Client(this.server, this.signal, () => this.access()); }
}
