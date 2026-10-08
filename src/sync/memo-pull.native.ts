// REQ-066: reconcile confirmed local notes with the Server's active and trash lists.
import { downloadMemoObject, fetchActiveMemos, fetchTrashMemos, type ServerMemo } from '@/api/memo-sync';
import type { ServerConnectionConfig } from '@/api/server-connection';
import { getDatabase } from '@/storage/database.native';
import { hashFileBytes } from '@/storage/file-objects.native';
import { deleteMemoObjects, deleteObjectKeys, persistDownloadedObject } from '@/storage/objects.native';
import { createUuid } from '@/sync/uuid';

type StoredImage = { id: string; object_key: string };
type StoredFile = { id: string; object_key: string };

const imageExtension: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif',
};

async function downloadRemoteAttachments(config: ServerConnectionConfig, remote: ServerMemo,
  existingImages: StoredImage[], existingFiles: StoredFile[]) {
  const imageById = new Map(existingImages.map((image) => [image.id, image.object_key]));
  const fileById = new Map(existingFiles.map((file) => [file.id, file.object_key]));
  const downloadedKeys: string[] = [];
  const images: StoredImage[] = [];
  const files: (StoredFile & { name: string; media_type: string; size: number; sha256: string })[] = [];
  try {
    for (const id of remote.images) {
      let key = imageById.get(id);
      if (!key) {
        const object = await downloadMemoObject(config, `/api/v1/objects/${encodeURIComponent(id)}`);
        const extension = imageExtension[object.mediaType];
        if (!extension || object.bytes.length > 10 * 1024 * 1024) throw new Error(`Remote image ${id} has invalid type or size`);
        key = persistDownloadedObject(remote.note_id, extension, object.bytes);
        downloadedKeys.push(key);
      }
      images.push({ id, object_key: key });
    }
    for (const id of remote.files) {
      const metadata = remote.file_attachments.find((file) => file.id === id);
      if (!metadata) throw new Error(`Remote file ${id} has no metadata`);
      let key = fileById.get(id);
      if (!key) {
        const object = await downloadMemoObject(config, `/api/v1/files/${encodeURIComponent(id)}`);
        if (object.bytes.length !== metadata.size || object.mediaType !== metadata.media_type ||
          await hashFileBytes(object.bytes.buffer as ArrayBuffer) !== metadata.sha256) {
          throw new Error(`Remote file ${id} failed integrity check`);
        }
        const extension = metadata.name.split('.').at(-1)?.toLowerCase();
        if (!extension || !/^[a-z0-9]{1,8}$/.test(extension)) throw new Error(`Remote file ${id} has invalid extension`);
        key = persistDownloadedObject(remote.note_id, extension, object.bytes);
        downloadedKeys.push(key);
      }
      files.push({ ...metadata, object_key: key });
    }
    return { images, files, downloadedKeys };
  } catch (error) {
    deleteObjectKeys(downloadedKeys);
    throw error;
  }
}

async function applyRemoteMemo(config: ServerConnectionConfig, remote: ServerMemo) {
  const database = await getDatabase();
  const pending = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM memo_outbox WHERE memo_id = ? AND state != 'acked'`, remote.note_id,
  );
  if ((pending?.count ?? 0) > 0) return;
  const local = await database.getFirstAsync<{ server_version: number | null }>(
    'SELECT server_version FROM memos WHERE id = ?', remote.note_id,
  );
  if (local && (local.server_version ?? 0) >= remote.version) return;
  const existingImages = await database.getAllAsync<StoredImage>('SELECT id,object_key FROM memo_images WHERE memo_id=?', remote.note_id);
  const existingFiles = await database.getAllAsync<StoredFile>('SELECT id,object_key FROM memo_files WHERE memo_id=?', remote.note_id);
  const downloaded = await downloadRemoteAttachments(config, remote, existingImages, existingFiles);
  try {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `INSERT INTO memos (id,content,created_at,updated_at,server_version,deleted_at,expires_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,
         server_version=excluded.server_version,deleted_at=excluded.deleted_at,expires_at=excluded.expires_at,purged_at=NULL`,
        remote.note_id, remote.content, remote.created_at, remote.updated_at, remote.version, remote.deleted_at, remote.expires_at,
      );
      await transaction.runAsync('DELETE FROM memo_images WHERE memo_id=?', remote.note_id);
      await transaction.runAsync('DELETE FROM memo_files WHERE memo_id=?', remote.note_id);
      for (const [position, image] of downloaded.images.entries()) await transaction.runAsync(
        'INSERT INTO memo_images(id,memo_id,object_key,position) VALUES (?,?,?,?)', image.id, remote.note_id, image.object_key, position,
      );
      for (const [position, file] of downloaded.files.entries()) await transaction.runAsync(
        `INSERT INTO memo_files(id,memo_id,object_key,name,media_type,size,sha256,position) VALUES (?,?,?,?,?,?,?,?)`,
        file.id, remote.note_id, file.object_key, file.name, file.media_type, file.size, file.sha256, position,
      );
      if (!local) await transaction.runAsync(
        `INSERT INTO memo_outbox(operation_id,memo_id,operation,payload,state,result_version,created_at)
         VALUES (?,?,'create','{}','acked',?,?)`, createUuid(), remote.note_id, remote.version, remote.updated_at,
      );
    });
  } catch (error) {
    deleteObjectKeys(downloaded.downloadedKeys);
    throw error;
  }
  const currentKeys = new Set([...downloaded.images, ...downloaded.files].map((item) => item.object_key));
  deleteObjectKeys([...existingImages, ...existingFiles].map((item) => item.object_key).filter((key) => !currentKeys.has(key)));
}

export async function pullRemoteMemos(config: ServerConnectionConfig) {
  const [active, trash] = await Promise.all([fetchActiveMemos(config), fetchTrashMemos(config)]);
  const remote = [...active, ...trash];
  const remoteIds = new Set(remote.map((memo) => memo.note_id));
  for (const memo of remote) await applyRemoteMemo(config, memo);
  const database = await getDatabase();
  const local = await database.getAllAsync<{ id: string }>(
    `SELECT id FROM memos WHERE server_version IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM memo_outbox WHERE memo_outbox.memo_id=memos.id AND memo_outbox.state!='acked')`,
  );
  for (const memo of local) {
    if (remoteIds.has(memo.id)) continue;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync('DELETE FROM memo_files WHERE memo_id=?', memo.id);
      await transaction.runAsync('DELETE FROM memo_images WHERE memo_id=?', memo.id);
      await transaction.runAsync('DELETE FROM memos WHERE id=?', memo.id);
    });
    deleteMemoObjects(memo.id);
  }
}
