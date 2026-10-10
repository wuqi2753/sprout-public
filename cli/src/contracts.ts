// REQ-087–REQ-092: validate every disk and HTTP boundary before using it.
export type JsonObject = Record<string, unknown>;
export function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error(`${label} must be a nonempty string (max 4096)`);
  return value;
}
export function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}
export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error(`${label} must be an array (max 10000)`);
  return value.map((item) => string(item, label));
}
export function tags(value: unknown): string[] {
  const normalized = [...new Set(strings(value, 'tags'))].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (!normalized.length || normalized.length > 100 || normalized.some((tag) => !tag || Buffer.byteLength(tag) > 256 || /[\s#]/u.test(tag))) throw new Error('tags must contain 1–100 labels, each <=256 UTF-8 bytes without whitespace or #');
  return normalized;
}
export function sameTags(left: string[], right: string[]): boolean { return JSON.stringify(tags(left)) === JSON.stringify(tags(right)); }
export function serverURL(value: unknown): string {
  let url: URL;
  try { url = new URL(string(value, 'server URL')); } catch { throw new Error('server URL must be an absolute HTTPS origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('server URL must be an HTTPS origin (HTTP only on loopback), without credentials, path, query or fragment');
  return url.origin;
}
export function subscription(value: unknown) {
  const result = object(value, 'subscription');
  const cursor = result.acknowledged_cursor;
  if (cursor !== null && typeof cursor !== 'string') throw new Error('acknowledged_cursor must be an opaque string or null');
  return { subscription_id: string(result.subscription_id, 'subscription_id'), tags: tags(result.tags), acknowledged_cursor: cursor };
}
export type Phase = 'initial' | 'incremental' | 'backfill';
export type Receipt = { receipt: string; phase: Phase; done: boolean };
export function receipt(value: unknown): Receipt {
  const result = object(value, 'receipt');
  if (!['initial', 'incremental', 'backfill'].includes(result.phase as string) || typeof result.done !== 'boolean') throw new Error('page requires a valid phase and boolean done');
  return { receipt: string(result.receipt, 'receipt'), phase: result.phase as Phase, done: result.done };
}
export type Note = JsonObject & { note_id: string; content: string; version: number; images: string[]; files: string[] };
export function note(value: unknown): Note {
  const result = object(value, 'note');
  const id = string(result.note_id, 'note_id');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || typeof result.content !== 'string' || result.content.length > 1048576) throw new Error('note_id or content is invalid');
  const images = strings(result.images, 'images'); const files = strings(result.files, 'files');
  if (images.length + files.length > 5 || images.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?:[0-8]$/.test(id)) || files.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?:file$/.test(id))) throw new Error('note attachment identifiers are invalid');
  return { ...result, note_id: id, content: result.content, version: integer(result.version, 'note.version'), images, files };
}
export type Item = { action: 'upsert'; note: Note } | { action: 'stop'; note_id: string };
export function page(value: unknown): Receipt & { items: Item[] } {
  const result = object(value, 'page');
  if (!Array.isArray(result.items) || result.items.length > 50) throw new Error('page.items must contain at most 50 items');
  const items: Item[] = result.items.map((value) => {
    const item = object(value, 'page item');
    if (item.action === 'upsert') return { action: 'upsert', note: note(item.note) };
    if (item.action === 'stop') {
      const id = string(item.note_id, 'stop.note_id');
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('stop.note_id is invalid');
      return { action: 'stop', note_id: id };
    }
    throw new Error('page item action must be upsert or stop');
  });
  return { ...receipt(result), items };
}
