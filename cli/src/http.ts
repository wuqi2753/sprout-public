// REQ-088–REQ-092: no redirects, bounded bodies, timeout and redacted errors.
import { object } from './contracts.js';
export class HTTPFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Server request failed (${status}, ${code})`); }
}
export class Client {
  constructor(readonly server: string, readonly signal: AbortSignal, readonly access?: () => Promise<string>) {}
  async request(path: string, body?: unknown, form = false, bytes = false, method?: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.access) headers.Authorization = `Bearer ${await this.access()}`;
    if (body !== undefined) headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    let response: Response;
    try {
      response = await fetch(this.server + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : form ? (body as URLSearchParams).toString() : JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([this.signal, AbortSignal.timeout(30000)]) });
    } catch { throw new Error('Server request interrupted or unavailable; verify connectivity and retry (OAuth exchange/refresh may require login)'); }
    const limit = bytes ? 50 * 1024 * 1024 : 5 * 1024 * 1024;
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) {
      try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > limit) throw new Error('Server response exceeds the supported size limit'); chunks.push(result.value); } }
      finally { await reader.cancel(); }
    }
    const buffer = Buffer.concat(chunks);
    if (!response.ok) {
      let code = 'http_error';
      try { const failure = object(JSON.parse(buffer.toString()), 'error'); const error = failure.error; const candidate = typeof error === 'string' ? error : object(error, 'error').code; if (typeof candidate === 'string' && /^[a-z_]{1,64}$/.test(candidate)) code = candidate; } catch { /* Report HTTP status even for malformed error bodies. */ }
      throw new HTTPFailure(response.status, code);
    }
    if (bytes) return buffer;
    if (!buffer.length && path === '/oauth/revoke') return {};
    try { return JSON.parse(buffer.toString()); } catch { throw new Error('Server returned invalid JSON'); }
  }
  async patch(path: string, body: unknown): Promise<unknown> {
    return this.request(path, body, false, false, 'PATCH');
  }
}
