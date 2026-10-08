export type OutboxOperation = 'create' | 'update' | 'delete' | 'restore' | 'purge';

export type OutboxRow = {
  operationId: string;
  memoId: string;
  operation: OutboxOperation;
  payload: string;
  attemptCount: number;
};

export type MemoOperationRequest = {
  operationId: string;
  memoId: string;
  operation: OutboxOperation;
  content?: string;
  createdAt?: string;
  baseVersion?: number;
  images?: string[];
  imageObjects?: { id: string; object_key: string }[];
  files?: string[];
  fileObjects?: OutboxFileObject[];
};

export type OutboxFileObject = {
  id: string; object_key: string; name: string; media_type: string; size: number; sha256: string;
};

export type OutboxFailure = {
  retryable: boolean;
  message: string;
};

export type MemoOutboxDependencies = {
  recoverSendingOperations(): Promise<void>;
  getPendingOperations(): Promise<OutboxRow[]>;
  markSending(operationId: string): Promise<void>;
  getLastServerVersion(memoId: string): Promise<number | undefined>;
  getAppliedOperationVersion(operationId: string, memoId: string, operation: OutboxOperation): Promise<number | undefined>;
  sendMemoOperation(operation: MemoOperationRequest): Promise<number>;
  markAcknowledged(operationId: string, resultVersion: number): Promise<void>;
  markFailed(row: OutboxRow, failure: OutboxFailure): Promise<void>;
  classifyFailure(error: unknown): OutboxFailure;
};

type OperationPayload = {
  content?: string; created_at?: string; images?: string[];
  image_objects?: { id: string; object_key: string }[];
  files?: string[];
  file_objects?: OutboxFileObject[];
};

export async function synchronizeMemoOutbox(dependencies: MemoOutboxDependencies) {
  await dependencies.recoverSendingOperations();
  const rows = await dependencies.getPendingOperations();
  const blockedMemoIds = new Set<string>();

  for (const row of rows) {
    if (blockedMemoIds.has(row.memoId)) continue;
    await dependencies.markSending(row.operationId);
    try {
      let resultVersion = row.attemptCount > 0
        ? await dependencies.getAppliedOperationVersion(row.operationId, row.memoId, row.operation)
        : undefined;
      if (resultVersion === undefined) {
        const payload = JSON.parse(row.payload) as OperationPayload;
        resultVersion = await dependencies.sendMemoOperation({
          operationId: row.operationId,
          memoId: row.memoId,
          operation: row.operation,
          content: payload.content,
          createdAt: payload.created_at,
          images: payload.images,
          imageObjects: payload.image_objects,
          files: payload.files,
          fileObjects: payload.file_objects,
          baseVersion: row.operation === 'create'
            ? undefined
            : await dependencies.getLastServerVersion(row.memoId),
        });
      }
      await dependencies.markAcknowledged(row.operationId, resultVersion);
    } catch (error) {
      await dependencies.markFailed(row, dependencies.classifyFailure(error));
      blockedMemoIds.add(row.memoId);
    }
  }
}
