import { getDatabase } from '@/storage/database.native';
import { deleteMemoObjects, deleteObjectKeys, persistMemoImages, resolveObjectUri } from '@/storage/objects.native';
import { extractTags } from '@/memos';
import type { CreateMemoInput, Memo, MemoEditInput } from '@/types/memo';
import { createUuid } from '@/sync/uuid';
import { persistMemoFile } from '@/storage/file-objects.native';
import { validateFileAttachment } from '@/storage/file-attachment-rules';
import type { StoredFileAttachment } from '@/types/attachment';
import { rememberRecordingStart } from '@/storage/recording-start';
import { earliestRecordingDate } from '@/storage/memo-statistics-rules';

type MemoRow = {
  id: string;
  content: string;
  created_at: string;
  updated_at: string;
  synced: number;
  hidden: number;
  deleted_at: string | null;
  expires_at: string | null;
};

type MemoImageRow = {
  memo_id: string;
  object_key: string;
};

type MemoFileRow = {
  id: string; memo_id: string; object_key: string; name: string;
  media_type: string; size: number; sha256: string;
};

function parseStoredDate(value: string, fieldName: string, memoId: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Memo ${memoId} has invalid ${fieldName}: ${value}`);
  }
  return date;
}

async function readMemos(deleted: boolean): Promise<Memo[]> {
  const database = await getDatabase();
  const memoRows = await database.getAllAsync<MemoRow>(
    `SELECT id, content, created_at, updated_at, hidden, deleted_at, expires_at,
      NOT EXISTS (
        SELECT 1 FROM memo_outbox
        WHERE memo_outbox.memo_id = memos.id AND memo_outbox.state != 'acked'
      ) AS synced
     FROM memos WHERE purged_at IS NULL AND ${deleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'}
     ORDER BY ${deleted ? 'deleted_at' : 'created_at'} DESC, id DESC`,
  );
  const imageRows = await database.getAllAsync<MemoImageRow>(
    'SELECT memo_id, object_key FROM memo_images ORDER BY memo_id, position',
  );
  const imageUrisByMemoId = new Map<string, string[]>();
  const fileRows = await database.getAllAsync<MemoFileRow>('SELECT * FROM memo_files ORDER BY memo_id, position');
  const filesByMemoId = new Map<string, StoredFileAttachment[]>();
  for (const file of fileRows) {
    const metadata = validateFileAttachment(file.name, file.size);
    const fileSuffix = file.id.slice(file.memo_id.length);
    const validFileId = file.id.startsWith(`${file.memo_id}:`) && /^(:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?:file$/.test(fileSuffix);
    if (metadata.mediaType !== file.media_type || !/^[a-f0-9]{64}$/.test(file.sha256) || !validFileId) {
      throw new Error(`Invalid stored file metadata for memo ${file.memo_id}`);
    }
    const attachments = filesByMemoId.get(file.memo_id) ?? [];
    attachments.push({ ...metadata, id: file.id, objectKey: file.object_key, uri: resolveObjectUri(file.object_key), sha256: file.sha256 });
    filesByMemoId.set(file.memo_id, attachments);
  }
  for (const imageRow of imageRows) {
    const imageUris = imageUrisByMemoId.get(imageRow.memo_id) ?? [];
    imageUris.push(resolveObjectUri(imageRow.object_key));
    imageUrisByMemoId.set(imageRow.memo_id, imageUris);
  }

  for (const memoRow of memoRows) {
    if (memoRow.hidden !== 0 && memoRow.hidden !== 1) {
      throw new Error(`Memo ${memoRow.id} has invalid hidden state`);
    }
  }
  await rememberRecordingStart(memoRows.map((memoRow) => parseStoredDate(memoRow.created_at, 'created_at', memoRow.id)));
  return memoRows.map((memoRow) => ({
    id: memoRow.id,
    content: memoRow.content,
    createdOn: parseStoredDate(memoRow.created_at, 'created_at', memoRow.id),
    savedAt: parseStoredDate(memoRow.updated_at, 'updated_at', memoRow.id),
    tags: extractTags(memoRow.content),
    imageUris: imageUrisByMemoId.get(memoRow.id) ?? [],
    synced: memoRow.synced === 1,
    hidden: memoRow.hidden === 1,
    deletedAt: memoRow.deleted_at ? parseStoredDate(memoRow.deleted_at, 'deleted_at', memoRow.id) : undefined,
    expiresAt: memoRow.expires_at ? parseStoredDate(memoRow.expires_at, 'expires_at', memoRow.id) : undefined,
    fileAttachments: filesByMemoId.get(memoRow.id) ?? [],
  }));
}

export async function getMemos(): Promise<Memo[]> { return readMemos(false); }

export async function getTrashMemos(): Promise<Memo[]> { return readMemos(true); }

export async function getMemo(id: string) {
  return (await getMemos()).find((memo) => memo.id === id);
}

// REQ-043: docs/stories/v0.2.0/REQ-043-hide-memos.md
export async function setMemoHidden(id: string, hidden: boolean) {
  if (typeof hidden !== 'boolean') throw new Error('Memo hidden must be a boolean');
  const database = await getDatabase();
  const result = await database.runAsync('UPDATE memos SET hidden = ? WHERE id = ?', hidden ? 1 : 0, id);
  if (result.changes !== 1) throw new Error(`Cannot change visibility of missing memo: ${id}`);
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
  earliestRecordingDate(null, [input.createdOn]);
  const normalizedContent = input.content.trim();
  const files = input.fileAttachments ?? [];
  if (input.imageUris.length + files.length > 5) throw new Error('图片和文件合计不能超过 5 个。');
  if (!normalizedContent && input.imageUris.length === 0 && !files.length) {
    throw new Error('Cannot save a memo without text or attachments');
  }
  if (Number.isNaN(input.createdOn.getTime())) {
    throw new Error(`Cannot save memo ${input.id} with an invalid creation date`);
  }

  const objectKeys = await persistMemoImages(input.id, input.imageUris);
  const createdAt = input.createdOn.toISOString();
  try {
    const attachments: StoredFileAttachment[] = [];
    for (const file of files) attachments.push(await persistMemoFile(input.id, file, createUuid()));
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
          files: attachments.map((file) => file.id),
          file_objects: attachments.map((file) => ({ id: file.id, object_key: file.objectKey,
            name: file.name, media_type: file.mediaType, size: file.size, sha256: file.sha256 })),
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
      for (const [position, attachment] of attachments.entries()) await transaction.runAsync(
        'INSERT INTO memo_files (id, memo_id, object_key, name, media_type, size, sha256, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        attachment.id, input.id, attachment.objectKey, attachment.name, attachment.mediaType, attachment.size, attachment.sha256, position,
      );
    });
  } catch (error) {
    deleteMemoObjects(input.id);
    throw new Error(`Failed to save memo ${input.id}`, { cause: error });
  }
  await rememberRecordingStart([input.createdOn]);
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

// REQ-047: attachment references and their immutable Outbox snapshot commit together.
export async function updateMemoDraft(id: string, draft: MemoEditInput, savedAt: Date) {
  const content = draft.content.trim();
  const files = draft.fileAttachments ?? [];
  if (!content && !draft.imageUris.length && !files.length) throw new Error('记录内容不能为空');
  if (draft.imageUris.length + files.length > 5) throw new Error('附件数量无效：图片和文件合计不能超过 5 个。');
  if (Number.isNaN(savedAt.getTime())) throw new Error('保存时间无效');
  const existing = await getMemo(id);
  if (!existing) throw new Error(`Cannot update missing memo: ${id}`);
  const database = await getDatabase();
  const previousImages = await database.getAllAsync<{ id: string; object_key: string }>(
    'SELECT id, object_key FROM memo_images WHERE memo_id = ? ORDER BY position', id,
  );
  const revision = createUuid();
  const createdObjectKeys: string[] = [];
  try {
    const images: { id: string; object_key: string }[] = [];
    for (const [position, uri] of draft.imageUris.entries()) {
      const previous = previousImages.find((image) => resolveObjectUri(image.object_key) === uri && !images.some((selected) => selected.id === image.id));
      if (previous) images.push({ id: previous.id, object_key: previous.object_key });
      else {
        const [objectKey] = await persistMemoImages(id, [uri]);
        createdObjectKeys.push(objectKey);
        images.push({ id: `${id}:${revision}:${position}`, object_key: objectKey });
      }
    }
    const attachments: StoredFileAttachment[] = [];
    for (const file of files) {
      const previous = existing.fileAttachments.find((stored) => stored.uri === file.uri && stored.name === file.name && !attachments.some((selected) => selected.id === stored.id));
      if (previous) attachments.push(previous);
      else {
        const attachment = await persistMemoFile(id, file, createUuid());
        createdObjectKeys.push(attachment.objectKey);
        attachments.push(attachment);
      }
    }
    const updatedAt = savedAt.toISOString();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const result = await transaction.runAsync('UPDATE memos SET content = ?, updated_at = ? WHERE id = ?', content, updatedAt, id);
      if (result.changes !== 1) throw new Error(`Cannot update missing memo: ${id}`);
      await transaction.runAsync('DELETE FROM memo_images WHERE memo_id = ?', id);
      for (const [position, image] of images.entries()) {
        await transaction.runAsync('INSERT INTO memo_images (id, memo_id, object_key, position) VALUES (?, ?, ?, ?)', image.id, id, image.object_key, position);
      }
      await transaction.runAsync('DELETE FROM memo_files WHERE memo_id = ?', id);
      for (const [position, attachment] of attachments.entries()) await transaction.runAsync(
        'INSERT INTO memo_files (id, memo_id, object_key, name, media_type, size, sha256, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        attachment.id, id, attachment.objectKey, attachment.name, attachment.mediaType, attachment.size, attachment.sha256, position,
      );
      await transaction.runAsync(
        `INSERT INTO memo_outbox (operation_id, memo_id, operation, payload, state, created_at)
         VALUES (?, ?, 'update', ?, 'pending', ?)`,
        createUuid(), id, JSON.stringify({ content, images: images.map((image) => image.id), image_objects: images,
          files: attachments.map((file) => file.id), file_objects: attachments.map((file) => ({ id: file.id, object_key: file.objectKey,
            name: file.name, media_type: file.mediaType, size: file.size, sha256: file.sha256 })) }), updatedAt,
      );
    });
  } catch (error) {
    deleteObjectKeys(createdObjectKeys);
    throw error;
  }
}

// REQ-049: retain the extension and version the name alongside the immutable file snapshot.
export async function renameMemoFile(id: string, fileId: string, filenameStem: string) {
  const stem = filenameStem.trim();
  if (!stem || /[\\/\u0000-\u001f\u007f]/.test(stem)) throw new Error('文件名称不能为空，也不能包含路径分隔符或控制字符。');
  const memo = await getMemo(id);
  const attachment = memo?.fileAttachments.find((file) => file.id === fileId);
  if (!memo || !attachment) throw new Error('记录或文件附件已不存在。');
  const extension = attachment.name.slice(attachment.name.lastIndexOf('.'));
  const name = `${stem}${extension}`;
  if (name === attachment.name) return;
  await updateMemoDraft(id, { content: memo.content, imageUris: memo.imageUris,
    fileAttachments: memo.fileAttachments.map((file) => file.id === fileId ? { ...file, name } : file) }, new Date());
}

// REQ-052: remove only the selected file; a record with no remaining content is deleted.
export async function removeMemoFile(id: string, fileId: string) {
  const memo = await getMemo(id);
  if (!memo || !memo.fileAttachments.some((file) => file.id === fileId)) throw new Error('记录或文件附件已不存在。');
  const fileAttachments = memo.fileAttachments.filter((file) => file.id !== fileId);
  if (!memo.content.trim() && !memo.imageUris.length && !fileAttachments.length) await deleteMemo(id);
  else await updateMemoDraft(id, { content: memo.content, imageUris: memo.imageUris, fileAttachments }, new Date());
}

export async function deleteMemo(id: string) {
  // REQ-061: retain the initial date even when deleting all remaining memos.
  await getMemos();
  const database = await getDatabase();
  const deletedAt = new Date().toISOString();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const memo = await transaction.getFirstAsync<{ hidden: number }>('SELECT hidden FROM memos WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL', id);
    if (!memo || (memo.hidden !== 0 && memo.hidden !== 1)) throw new Error(`Cannot delete missing or invalid memo: ${id}`);
    const permanentlyDelete = memo.hidden === 1;
    const result = await transaction.runAsync(
      'UPDATE memos SET deleted_at = ?, expires_at = NULL, purged_at = ? WHERE id = ? AND deleted_at IS NULL AND purged_at IS NULL',
      permanentlyDelete ? null : deletedAt, permanentlyDelete ? deletedAt : null, id,
    );
    if (result.changes !== 1) throw new Error(`Cannot delete missing memo: ${id}`);
    await transaction.runAsync(
      `INSERT INTO memo_outbox
        (operation_id, memo_id, operation, payload, state, created_at)
       VALUES (?, ?, ?, '{}', 'pending', ?)`,
      createUuid(),
      id,
      permanentlyDelete ? 'purge' : 'delete',
      deletedAt,
    );
  });
  // Attachments remain available for recovery until the Server confirms a purge.
}

export async function restoreMemo(id: string) {
  const database = await getDatabase();
  const restoredAt = new Date().toISOString();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const memo = await transaction.getFirstAsync<{ deleted_at: string; expires_at: string | null }>(
      'SELECT deleted_at, expires_at FROM memos WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL', id,
    );
    if (!memo) throw new Error(`Cannot restore missing trash memo: ${id}`);
    const result = await transaction.runAsync('UPDATE memos SET deleted_at = NULL, expires_at = NULL WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL', id);
    if (result.changes !== 1) throw new Error(`Cannot restore missing trash memo: ${id}`);
    await transaction.runAsync(`INSERT INTO memo_outbox (operation_id,memo_id,operation,payload,state,created_at) VALUES (?,?,'restore',?,'pending',?)`,
      createUuid(), id, JSON.stringify(memo), restoredAt);
  });
}

export async function purgeMemo(id: string) {
  const database = await getDatabase();
  const purgedAt = new Date().toISOString();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const result = await transaction.runAsync('UPDATE memos SET purged_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL', purgedAt, id);
    if (result.changes !== 1) throw new Error(`Cannot purge missing trash memo: ${id}`);
    await transaction.runAsync(`INSERT INTO memo_outbox (operation_id,memo_id,operation,payload,state,created_at) VALUES (?,?,'purge','{}','pending',?)`, createUuid(), id, purgedAt);
  });
}

export async function clearTrashMemos() {
  const database = await getDatabase();
  const purgedAt = new Date().toISOString();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const memos = await transaction.getAllAsync<{ id: string }>('SELECT id FROM memos WHERE deleted_at IS NOT NULL AND purged_at IS NULL');
    for (const memo of memos) {
      const result = await transaction.runAsync('UPDATE memos SET purged_at=? WHERE id=? AND purged_at IS NULL', purgedAt, memo.id);
      if (result.changes !== 1) throw new Error(`Cannot clear trash memo: ${memo.id}`);
      await transaction.runAsync(`INSERT INTO memo_outbox (operation_id,memo_id,operation,payload,state,created_at) VALUES (?,?,'purge','{}','pending',?)`, createUuid(), memo.id, purgedAt);
    }
  });
}
