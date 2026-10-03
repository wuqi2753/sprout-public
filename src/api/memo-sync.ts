import { normalizeServerApiUrl, type ServerConnectionConfig } from '@/api/server-connection';

export type MemoOperation = {
  operationId: string;
  memoId: string;
  operation: 'create' | 'update' | 'delete';
  content?: string;
  createdAt?: string;
  baseVersion?: number;
  images?: string[];
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

async function request(config: ServerConnectionConfig, path: string, init: RequestInit) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 8000);
  try {
    const response = await fetch(`${normalizeServerApiUrl(config.serverApiUrl)}${path}`, {
      ...init,
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
      throw new MemoSyncError(response.status === 429 || response.status >= 500, response.status, code);
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
        created_at: operation.createdAt,
      }),
    });
    confirmImages(body, operation.images);
    return readResultVersion(body);
  }
  if (!operation.baseVersion) throw new MemoSyncError(false, undefined, 'Missing Server version');
  const body = await request(config, `/api/v1/notes/${encodeURIComponent(operation.memoId)}`, {
    method: operation.operation === 'update' ? 'PATCH' : 'DELETE',
    headers,
    body: JSON.stringify(
      operation.operation === 'update'
        ? { content: operation.content, images: operation.images, base_version: operation.baseVersion }
        : { base_version: operation.baseVersion },
    ),
  });
  confirmImages(body, operation.images);
  return readResultVersion(body);
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
