// REQ-040: copy while the external provider's temporary read grant is valid.
import { Directory, File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import { createUuid } from '@/sync/uuid';
import { FILE_MEDIA_TYPES, validateFileAttachment } from '@/storage/file-attachment-rules';
import type { FileAttachment } from '@/types/attachment';

export async function copyIncomingFile(uri: string, name: string, declaredSize?: number): Promise<FileAttachment> {
  if (!/^(file|content):\//i.test(uri)) throw new Error('请先下载文件，再分享给 Sprout。');
  const normalizedUri = uri.startsWith('file:') ? new URL(uri).toString() : uri;
  if (declaredSize !== undefined) validateFileAttachment(name, declaredSize);
  const directory = new Directory(Paths.cache, 'file-imports');
  directory.create({ intermediates: true, idempotent: true });
  const destination = new File(directory, createUuid());
  try {
    await new File(normalizedUri).copy(destination);
    const metadata = validateFileAttachment(name, destination.size);
    return { uri: destination.uri, ...metadata };
  } catch (error) {
    if (destination.exists) destination.delete();
    throw error;
  }
}

// REQ-052: selections import atomically; excess files are never silently dropped.
export async function chooseFileAttachments(remainingSlots: number): Promise<FileAttachment[]> {
  if (!Number.isInteger(remainingSlots) || remainingSlots < 1 || remainingSlots > 5) throw new Error('图片和文件合计最多 5 个，请先移除附件。');
  const result = await DocumentPicker.getDocumentAsync({ type: Object.values(FILE_MEDIA_TYPES), multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  const attachments: FileAttachment[] = [];
  try {
    if (result.assets.length > remainingSlots) throw new Error(`图片和文件合计最多 5 个，还可添加 ${remainingSlots} 个。`);
    for (const selected of result.assets) attachments.push(await copyIncomingFile(selected.uri, selected.name, selected.size));
    return attachments;
  } catch (error) {
    for (const attachment of attachments) discardImportedFile(attachment);
    throw error;
  } finally {
    for (const selected of result.assets) discardPrivateCacheCopy(selected.uri);
  }
}

export function discardPrivateCacheCopy(uri: string) {
  if (!uri.startsWith('file:')) return; // provider source is never ours to delete
  const normalizedUri = new URL(uri).toString();
  const cacheRoot = Paths.cache.uri.replace(/\/$/, '') + '/';
  if (!normalizedUri.startsWith(cacheRoot)) return;
  const file = new File(normalizedUri);
  if (file.exists) file.delete();
}

export function discardImportedFile(attachment: FileAttachment | undefined) {
  if (!attachment) return;
  const directory = new Directory(Paths.cache, 'file-imports');
  if (!attachment.uri.startsWith(`${directory.uri.replace(/\/$/, '')}/`)) throw new Error('Invalid imported file location');
  const file = new File(attachment.uri);
  if (file.exists) file.delete();
}

// REQ-040 / REQ-041: a new process has no in-memory draft or active preview.
export function discardAbandonedAttachmentCaches() {
  for (const name of ['file-imports', 'file-previews']) {
    const directory = new Directory(Paths.cache, name);
    if (directory.exists) directory.delete();
  }
}
