import { getAppliedOperationVersion, MemoSyncError, sendMemoOperation, uploadMemoImage } from '@/api/memo-sync';
import { File } from 'expo-file-system';
import { getDatabase } from '@/storage/database.native';
import { deleteMemoObjects, resolveObjectUri } from '@/storage/objects.native';
import { getServerConnectionConfig } from '@/storage/server-connection';
import { synchronizeMemoOutbox, type MemoOperationRequest, type OutboxRow } from '@/sync/memo-outbox-core';

type DatabaseOutboxRow = {
  operation_id: string;
  memo_id: string;
  operation: OutboxRow['operation'];
  payload: string;
  attempt_count: number;
};

let activeSync: Promise<void> | undefined;

function imageMediaType(uri: string) {
  const extension = uri.split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase();
  const mediaTypes: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif', gif: 'image/gif',
  };
  if (!extension || !mediaTypes[extension]) {
    throw new MemoSyncError(false, undefined, `Unsupported local image extension: ${extension ?? 'none'}`);
  }
  return mediaTypes[extension];
}

async function sendMemoWithImages(config: NonNullable<Awaited<ReturnType<typeof getServerConnectionConfig>>>, operation: MemoOperationRequest) {
  if (operation.images) {
    const database = await getDatabase();
    for (const imageId of operation.images) {
      const image = await database.getFirstAsync<{ object_key: string }>(
        'SELECT object_key FROM memo_images WHERE id = ? AND memo_id = ?', imageId, operation.memoId,
      );
      const objectKey = operation.imageObjects?.find((object) => object.id === imageId)?.object_key ?? image?.object_key;
      if (!objectKey) throw new MemoSyncError(false, undefined, `Missing local image ${imageId}`);
      const uri = resolveObjectUri(objectKey);
      const file = new File(uri);
      if (!file.exists) throw new MemoSyncError(false, undefined, `Missing local image file ${imageId}`);
      await uploadMemoImage(config, imageId, imageMediaType(uri), await file.arrayBuffer());
    }
  }
  return sendMemoOperation(config, operation);
}

async function lastServerVersion(memoId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ version: number | null }>(
    `SELECT MAX(result_version) AS version FROM memo_outbox
     WHERE memo_id = ? AND state = 'acked'`,
    memoId,
  );
  return row?.version ?? undefined;
}

async function markAcknowledged(operationId: string, resultVersion: number) {
  const database = await getDatabase();
  const operation = await database.getFirstAsync<{ memo_id: string; operation: string }>(
    'SELECT memo_id, operation FROM memo_outbox WHERE operation_id = ?', operationId,
  );
  if (operation?.operation === 'delete') deleteMemoObjects(operation.memo_id);
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const result = await transaction.runAsync(
      `UPDATE memo_outbox
       SET state = 'acked', result_version = ?, last_error = NULL, next_attempt_at = NULL
       WHERE operation_id = ? AND state = 'sending'`,
      resultVersion,
      operationId,
    );
    if (result.changes !== 1) throw new Error(`Cannot acknowledge missing sending operation: ${operationId}`);
    await transaction.runAsync(
      `UPDATE memos SET server_version = ?
       WHERE id = (SELECT memo_id FROM memo_outbox WHERE operation_id = ?)`,
      resultVersion,
      operationId,
    );
  });
}

async function markFailed(row: OutboxRow, retryable: boolean, message: string) {
  const database = await getDatabase();
  const attemptCount = row.attemptCount + 1;
  const retryDelay = Math.min(5 * 60_000, 2 ** Math.min(attemptCount, 8) * 1000);
  await database.runAsync(
    `UPDATE memo_outbox
     SET state = ?, next_attempt_at = ?, last_error = ?
     WHERE operation_id = ?`,
    retryable ? 'retryable_failed' : 'permanent_failed',
    retryable ? new Date(Date.now() + retryDelay).toISOString() : null,
    message,
    row.operationId,
  );
}

async function synchronizePendingMemos() {
  const config = await getServerConnectionConfig();
  if (!config) return;
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE memo_outbox
     SET state = 'pending', next_attempt_at = NULL, last_error = NULL
     WHERE state = 'permanent_failed' AND last_error IN ('invalid_api_key', 'http_401')`,
  );
  await synchronizeMemoOutbox({
    recoverSendingOperations: async () => {
      await database.runAsync(`UPDATE memo_outbox SET state = 'pending' WHERE state = 'sending'`);
    },
    getPendingOperations: async () => {
      const rows = await database.getAllAsync<DatabaseOutboxRow>(
        `SELECT operation_id, memo_id, operation, payload, attempt_count
         FROM memo_outbox
         WHERE state IN ('pending', 'retryable_failed')
           AND NOT EXISTS (
             SELECT 1 FROM memo_outbox AS earlier
             WHERE earlier.memo_id = memo_outbox.memo_id
               AND earlier.rowid < memo_outbox.rowid
               AND earlier.state = 'permanent_failed'
           )
         ORDER BY rowid`,
      );
      return rows.map((row) => ({
        operationId: row.operation_id,
        memoId: row.memo_id,
        operation: row.operation,
        payload: row.payload,
        attemptCount: row.attempt_count,
      }));
    },
    markSending: async (operationId) => {
      await database.runAsync(
        `UPDATE memo_outbox SET state = 'sending', attempt_count = attempt_count + 1 WHERE operation_id = ?`,
        operationId,
      );
    },
    getLastServerVersion: lastServerVersion,
    getAppliedOperationVersion: (operationId, memoId, operation) =>
      getAppliedOperationVersion(config, operationId, { memoId, operation }),
    sendMemoOperation: (operation) => sendMemoWithImages(config, operation),
    markAcknowledged,
    markFailed: (row, failure) => markFailed(row, failure.retryable, failure.message),
    classifyFailure: (error) => ({
      retryable: error instanceof MemoSyncError ? error.retryable : true,
      message: error instanceof Error ? error.message : 'unknown_sync_error',
    }),
  });
}

export function syncMemoOutbox() {
  activeSync ??= synchronizePendingMemos().finally(() => {
    activeSync = undefined;
  });
  return activeSync;
}
