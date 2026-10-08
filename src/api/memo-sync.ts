import { normalizeServerApiUrl, type ServerConnectionConfig } from '@/api/server-connection';

export type MemoOperation = {
  operationId: string;
  memoId: string;
  operation: 'create' | 'update' | 'delete' | 'restore' | 'purge';
  content?: string;
  createdAt?: string;
  baseVersion?: number;
  images?: string[];
  files?: string[];
  fileObjects?: { id: string; name: string; media_type: string; size: number; sha256: string }[];
};

export class MemoSyncError extends Error {
  constructor(
    public readonly retryable: boolean,
    public readonly statusCode: number | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MemoSyncError';
  }
}

async function request(config: ServerConnectionConfig, path: string, init: RequestInit, timeoutMs = 8000) {
  // REQ-045: Reject unsafe saved configurations before sending credentials.
  const serverApiUrl = normalizeServerApiUrl(config.serverApiUrl);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetch(`${serverApiUrl}${path}`, {
      ...init,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        ...init.headers,
      },
      signal: abortController.signal,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code =
        typeof body === 'object' && body !== null && 'error' in body &&
        typeof body.error === 'object' && body.error !== null && 'code' in body.error
          ? String(body.error.code)
          : `http_${response.status}`;
      throw new MemoSyncError(response.status === 429 || response.status >= 500 || (path.startsWith('/api/v1/files/') && [404, 405].includes(response.status)), response.status, code);
    }
    return body;
  } catch (error) {
    if (error instanceof MemoSyncError) throw error;
    throw new MemoSyncError(true, undefined, 'network_error', { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function readResultVersion(body: unknown) {
  if (
    typeof body !== 'object' || body === null || !('version' in body) ||
    typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1
  ) {
    throw new MemoSyncError(false, undefined, 'Server returned an invalid note version');
  }
  return body.version;
}

function confirmImages(body: unknown, expectedImages: string[] | undefined) {
  if (!expectedImages) return;
  if (
    typeof body !== 'object' || body === null || !('images' in body) ||
    !Array.isArray(body.images) || body.images.length !== expectedImages.length ||
    !body.images.every((image, index) => image === expectedImages[index])
  ) {
    throw new MemoSyncError(false, undefined, 'Server returned images that do not match the operation');
  }
}

function confirmFiles(body: unknown, expectedFiles: string[] | undefined, expectedMetadata?: MemoOperation['fileObjects']) {
  if (!expectedFiles) return;
  if (typeof body !== 'object' || body === null || !('files' in body) || !Array.isArray(body.files) ||
    body.files.length !== expectedFiles.length || !body.files.every((id, index) => id === expectedFiles[index])) {
    throw new MemoSyncError(false, undefined, 'Server returned files that do not match the operation');
  }
  if (expectedMetadata && (typeof body !== 'object' || body === null || !('file_attachments' in body) || !Array.isArray(body.file_attachments) ||
    body.file_attachments.length !== expectedMetadata.length || expectedMetadata.some((file, index) => {
      const received = (body.file_attachments as unknown[])[index];
      return typeof received !== 'object' || received === null ||
        ['id', 'name', 'media_type', 'size', 'sha256'].some((key) => (received as Record<string, unknown>)[key] !== (file as Record<string, unknown>)[key]);
    }))) throw new MemoSyncError(false, undefined, 'Server returned file metadata that does not match the operation');
}

export async function getAppliedOperationVersion(
  config: ServerConnectionConfig, operationId: string,
  expected?: { memoId: string; operation: MemoOperation['operation'] },
) {
  try {
    const body = await request(config, `/api/v1/sync/operations/${encodeURIComponent(operationId)}`, {
      method: 'GET',
    });
    if (
      typeof body !== 'object' || body === null || !('result_version' in body) ||
      typeof body.result_version !== 'number' ||
      !Number.isInteger(body.result_version) || body.result_version < 1
    ) {
      throw new MemoSyncError(false, undefined, 'Server returned an invalid operation status');
    }
    if (expected && (
      !('note_id' in body) || body.note_id !== expected.memoId ||
      !('operation' in body) || body.operation !== expected.operation ||
      !('status' in body) || body.status !== 'applied'
    )) {
      throw new MemoSyncError(false, undefined, 'Server returned a status for a different operation');
    }
    return body.result_version;
  } catch (error) {
    if (error instanceof MemoSyncError && error.statusCode === 404) return undefined;
    throw error;
  }
}

export async function sendMemoOperation(config: ServerConnectionConfig, operation: MemoOperation) {
  const headers = { 'Idempotency-Key': operation.operationId };
  if (operation.operation === 'create') {
    const body = await request(config, '/api/v1/notes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        note_id: operation.memoId,
        content: operation.content,
        images: operation.images,
        files: operation.files,
        created_at: operation.createdAt,
      }),
    });
    confirmImages(body, operation.images);
    confirmFiles(body, operation.files, operation.fileObjects);
    return readResultVersion(body);
  }
  if (!operation.baseVersion) throw new MemoSyncError(false, undefined, 'Missing Server version');
  const suffix = operation.operation === 'restore' || operation.operation === 'purge' ? `/${operation.operation}` : '';
  const body = await request(config, `/api/v1/notes/${encodeURIComponent(operation.memoId)}${suffix}`, {
    method: operation.operation === 'update' ? 'PATCH' : operation.operation === 'delete' ? 'DELETE' : 'POST',
    headers,
    body: JSON.stringify(
      operation.operation === 'update'
        ? { content: operation.content, created_at: operation.createdAt, images: operation.images, files: operation.files, base_version: operation.baseVersion }
        : { base_version: operation.baseVersion },
    ),
  });
  confirmImages(body, operation.images);
  confirmFiles(body, operation.files, operation.fileObjects);
  return readResultVersion(body);
}

export type ServerMemo = {
  note_id: string;
  content: string;
  images: string[];
  files: string[];
  file_attachments: { id: string; name: string; media_type: string; size: number; sha256: string }[];
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  expires_at: string | null;
};

function validateServerMemo(value: unknown): ServerMemo {
  if (typeof value !== 'object' || value === null) throw new MemoSyncError(false, undefined, 'Server returned an invalid note');
  const note = value as Record<string, unknown>;
  const images = note.images;
  const files = note.files;
  const attachments = note.file_attachments;
  const validFileAttachments = Array.isArray(files) && Array.isArray(attachments) && attachments.length === files.length &&
    attachments.every((value, index) => {
      if (typeof value !== 'object' || value === null) return false;
      const attachment = value as Record<string, unknown>;
      return attachment.id === files[index] && typeof attachment.name === 'string' && attachment.name.length > 0 &&
        typeof attachment.media_type === 'string' && attachment.media_type.length > 0 &&
        typeof attachment.size === 'number' && Number.isSafeInteger(attachment.size) && attachment.size >= 0 &&
        typeof attachment.sha256 === 'string' && /^[a-f0-9]{64}$/.test(attachment.sha256);
    });
  if (typeof note.note_id !== 'string' || note.note_id.length === 0 || typeof note.content !== 'string' ||
    typeof note.version !== 'number' || !Number.isInteger(note.version) || note.version < 1 ||
    !Array.isArray(images) || !images.every((id) => typeof id === 'string' && id.length > 0) || new Set(images).size !== images.length ||
    !Array.isArray(files) || !files.every((id) => typeof id === 'string' && id.length > 0) || new Set(files).size !== files.length ||
    !validFileAttachments ||
    typeof note.created_at !== 'string' || Number.isNaN(Date.parse(note.created_at)) ||
    typeof note.updated_at !== 'string' || Number.isNaN(Date.parse(note.updated_at)) ||
    (note.deleted_at !== null && (typeof note.deleted_at !== 'string' || Number.isNaN(Date.parse(note.deleted_at)))) ||
    (note.expires_at !== null && (typeof note.expires_at !== 'string' || Number.isNaN(Date.parse(note.expires_at)))) ||
    (note.deleted_at === null) !== (note.expires_at === null) ||
    (typeof note.deleted_at === 'string' && typeof note.expires_at === 'string' &&
      Date.parse(note.expires_at) <= Date.parse(note.deleted_at))) {
    throw new MemoSyncError(false, undefined, 'Server returned invalid note fields');
  }
  return note as ServerMemo;
}

async function fetchMemoList(config: ServerConnectionConfig, path: string): Promise<ServerMemo[]> {
  const body = await request(config, path, { method: 'GET' });
  if (typeof body !== 'object' || body === null || !('notes' in body) || !Array.isArray(body.notes)) {
    throw new MemoSyncError(false, undefined, 'Server returned an invalid note list');
  }
  return body.notes.map(validateServerMemo);
}

export function fetchTrashMemos(config: ServerConnectionConfig) { return fetchMemoList(config, '/api/v1/trash'); }
export function fetchActiveMemos(config: ServerConnectionConfig) { return fetchMemoList(config, '/api/v1/notes'); }

export async function fetchServerMemo(config: ServerConnectionConfig, memoId: string) {
  return validateServerMemo(await request(config, `/api/v1/notes/${encodeURIComponent(memoId)}`, { method: 'GET' }));
}

export async function downloadMemoObject(config: ServerConnectionConfig, path: string) {
  const serverApiUrl = normalizeServerApiUrl(config.serverApiUrl);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 60_000);
  try {
    const response = await fetch(`${serverApiUrl}${path}`, {
      method: 'GET', redirect: 'error', signal: abortController.signal,
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) throw new MemoSyncError(response.status >= 500 || response.status === 429, response.status, `object_http_${response.status}`);
    return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: response.headers.get('Content-Type') ?? '' };
  } catch (error) {
    if (error instanceof MemoSyncError) throw error;
    throw new MemoSyncError(true, undefined, 'object_network_error', { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export async function uploadMemoFile(
  config: ServerConnectionConfig,
  attachment: { id: string; name: string; media_type: string; size: number; sha256: string },
  bytes: ArrayBuffer,
) {
  const body = await request(config, `/api/v1/files/${encodeURIComponent(attachment.id)}`, {
    method: 'PUT', headers: { 'Content-Type': attachment.media_type, 'X-File-Name': encodeURIComponent(attachment.name), 'X-File-SHA256': attachment.sha256 }, body: bytes,
  }, 60_000);
  if (typeof body !== 'object' || body === null ||
    Object.entries(attachment).some(([key, value]) => !(key in body) || (body as Record<string, unknown>)[key] !== value)) {
    throw new MemoSyncError(false, undefined, 'Server returned file metadata that does not match the upload');
  }
}

export async function uploadMemoImage(
  config: ServerConnectionConfig, imageId: string, mediaType: string, bytes: ArrayBuffer,
) {
  const body = await request(config, `/api/v1/objects/${encodeURIComponent(imageId)}`, {
    method: 'PUT', headers: { 'Content-Type': mediaType }, body: bytes,
  });
  if (typeof body !== 'object' || body === null || !('image_id' in body) || body.image_id !== imageId) {
    throw new MemoSyncError(false, undefined, 'Server returned an image ID that does not match the upload');
  }
}
