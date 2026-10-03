import { getDatabase } from '@/storage/database.native';
import { deleteMemoObjects, persistMemoImages, resolveObjectUri } from '@/storage/objects.native';
import { extractTags } from '@/memos';
import type { CreateMemoInput, Memo } from '@/types/memo';
import { createUuid } from '@/sync/uuid';

type MemoRow = {
  id: string;
  content: string;
  created_at: string;
  updated_at: string;
  synced: number;
};

type MemoImageRow = {
  memo_id: string;
  object_key: string;
};

function parseStoredDate(value: string, fieldName: string, memoId: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Memo ${memoId} has invalid ${fieldName}: ${value}`);
  }
  return date;
}

export async function getMemos(): Promise<Memo[]> {
  const database = await getDatabase();
  const memoRows = await database.getAllAsync<MemoRow>(
    `SELECT id, content, created_at, updated_at,
      NOT EXISTS (
        SELECT 1 FROM memo_outbox
        WHERE memo_outbox.memo_id = memos.id AND memo_outbox.state != 'acked'
      ) AS synced
     FROM memos ORDER BY created_at DESC, id DESC`,
  );
  const imageRows = await database.getAllAsync<MemoImageRow>(
    'SELECT memo_id, object_key FROM memo_images ORDER BY memo_id, position',
  );
  const imageUrisByMemoId = new Map<string, string[]>();
  for (const imageRow of imageRows) {
    const imageUris = imageUrisByMemoId.get(imageRow.memo_id) ?? [];
    imageUris.push(resolveObjectUri(imageRow.object_key));
    imageUrisByMemoId.set(imageRow.memo_id, imageUris);
  }

  return memoRows.map((memoRow) => ({
    id: memoRow.id,
    content: memoRow.content,
    createdOn: parseStoredDate(memoRow.created_at, 'created_at', memoRow.id),
    savedAt: parseStoredDate(memoRow.updated_at, 'updated_at', memoRow.id),
    tags: extractTags(memoRow.content),
    imageUris: imageUrisByMemoId.get(memoRow.id) ?? [],
    synced: memoRow.synced === 1,
  }));
}

export async function getMemo(id: string) {
  return (await getMemos()).find((memo) => memo.id === id);
}

// REQ-039: docs/stories/v0.2.0/REQ-039-first-connection-welcome-memo.md
export async function initializeWelcomeMemo() {
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const initialized = await transaction.getFirstAsync<{ name: string }>(
      "SELECT name FROM app_initialization WHERE name = 'welcome_memo'",
    );
    if (initialized) return;
    const existingMemo = await transaction.getFirstAsync<{ id: string }>('SELECT id FROM memos LIMIT 1');
    if (!existingMemo) {
      const memoId = createUuid();
      const createdAt = new Date().toISOString();
      const content = '#开心 欢迎来到 Sprout!';
      await transaction.runAsync(
        'INSERT INTO memos (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)',
        memoId, content, createdAt, createdAt,
      );
      await transaction.runAsync(
        `INSERT INTO memo_outbox (operation_id, memo_id, operation, payload, state, created_at)
         VALUES (?, ?, 'create', ?, 'pending', ?)`,
        createUuid(), memoId, JSON.stringify({ content, created_at: createdAt, images: [], image_objects: [] }), createdAt,
      );
    }
    await transaction.runAsync("INSERT INTO app_initialization (name) VALUES ('welcome_memo')");
  });
}

export async function addMemo(input: CreateMemoInput) {
  const normalizedContent = input.content.trim();
  if (!normalizedContent && input.imageUris.length === 0) {
    throw new Error('Cannot save a memo without text or images');
  }
  if (Number.isNaN(input.createdOn.getTime())) {
    throw new Error(`Cannot save memo ${input.id} with an invalid creation date`);
  }

  const objectKeys = await persistMemoImages(input.id, input.imageUris);
  const createdAt = input.createdOn.toISOString();
  try {
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        'INSERT INTO memos (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)',
        input.id,
        normalizedContent,
        createdAt,
        createdAt,
      );
      await transaction.runAsync(
        `INSERT INTO memo_outbox
          (operation_id, memo_id, operation, payload, state, created_at)
         VALUES (?, ?, 'create', ?, 'pending', ?)`,
        createUuid(),
        input.id,
        JSON.stringify({
          content: normalizedContent,
          created_at: createdAt,
          images: objectKeys.map((_, position) => `${input.id}:${position}`),
          image_objects: objectKeys.map((objectKey, position) => ({ id: `${input.id}:${position}`, object_key: objectKey })),
        }),
        createdAt,
      );
      for (const [position, objectKey] of objectKeys.entries()) {
        await transaction.runAsync(
          'INSERT INTO memo_images (id, memo_id, object_key, position) VALUES (?, ?, ?, ?)',
          `${input.id}:${position}`,
          input.id,
          objectKey,
          position,
        );
      }
    });
  } catch (error) {
    deleteMemoObjects(input.id);
    throw new Error(`Failed to save memo ${input.id}`, { cause: error });
  }
}

export async function updateMemoContent(id: string, content: string, savedAt: Date) {
  const normalizedContent = content.trim();
  if (!normalizedContent) throw new Error(`Cannot update memo ${id} with empty text`);
  if (Number.isNaN(savedAt.getTime())) throw new Error(`Cannot update memo ${id} with an invalid saved date`);

  const database = await getDatabase();
  const updatedAt = savedAt.toISOString();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const result = await transaction.runAsync(
      'UPDATE memos SET content = ?, updated_at = ? WHERE id = ?',
      normalizedContent,
      updatedAt,
      id,
    );
    if (result.changes !== 1) throw new Error(`Cannot update missing memo: ${id}`);
    await transaction.runAsync(
      `INSERT INTO memo_outbox
        (operation_id, memo_id, operation, payload, state, created_at)
       VALUES (?, ?, 'update', ?, 'pending', ?)`,
      createUuid(),
      id,
      JSON.stringify({ content: normalizedContent }),
      updatedAt,
    );
  });
}

export async function deleteMemo(id: string) {
  const database = await getDatabase();
  const deletedAt = new Date().toISOString();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync('DELETE FROM memo_images WHERE memo_id = ?', id);
    const result = await transaction.runAsync('DELETE FROM memos WHERE id = ?', id);
    if (result.changes !== 1) throw new Error(`Cannot delete missing memo: ${id}`);
    await transaction.runAsync(
      `INSERT INTO memo_outbox
        (operation_id, memo_id, operation, payload, state, created_at)
       VALUES (?, ?, 'delete', '{}', 'pending', ?)`,
      createUuid(),
      id,
      deletedAt,
    );
  });
  // Keep image files until the Server confirms the queued delete. Earlier create operations may still need them.
}
