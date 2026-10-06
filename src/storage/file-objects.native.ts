// REQ-041: ordinary files are durable private objects; hashes cover original bytes.
import { Directory, File, Paths } from 'expo-file-system';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { validateFileAttachment } from '@/storage/file-attachment-rules';
import { resolveObjectUri } from '@/storage/objects.native';
import { createUuid } from '@/sync/uuid';
import type { FileAttachment, StoredFileAttachment } from '@/types/attachment';

export async function hashFileBytes(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes))))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function persistMemoFile(memoId: string, attachment: FileAttachment, revision?: string): Promise<StoredFileAttachment> {
  if (!/^[a-zA-Z0-9-]+$/.test(memoId)) throw new Error('Invalid memo ID for file storage');
  const source = new File(attachment.uri);
  if (!source.exists) throw new Error('待上传文件已失效，请重新选择。');
  const metadata = validateFileAttachment(attachment.name, source.size);
  if (metadata.size !== attachment.size || metadata.mediaType !== attachment.mediaType) throw new Error('文件已变化，请重新选择。');
  const directory = new Directory(Paths.document, 'sprout', 'objects', memoId);
  directory.create({ intermediates: true, idempotent: true });
  const objectKey = `${memoId}/${createUuid()}.${metadata.name.split('.').at(-1)?.toLowerCase()}`;
  const destination = new File(resolveObjectUri(objectKey));
  try {
    await source.copy(destination);
    const bytes = await destination.arrayBuffer();
    if (bytes.byteLength !== metadata.size) throw new Error('复制后的文件大小不一致，请重试。');
    const sha256 = await hashFileBytes(bytes);
    return { ...metadata, id: revision ? `${memoId}:${revision}:file` : `${memoId}:file`, objectKey, uri: destination.uri, sha256 };
  } catch (error) {
    if (destination.exists) destination.delete();
    throw error;
  }
}
