import { Directory, File, Paths } from 'expo-file-system';

const objectsDirectory = new Directory(Paths.document, 'sprout', 'objects');

function ensureObjectsDirectory() {
  if (!objectsDirectory.exists) objectsDirectory.create({ intermediates: true, idempotent: true });
}

function sanitizeExtension(imageUri: string) {
  const uriWithoutQuery = imageUri.split(/[?#]/, 1)[0];
  const extensionMatch = uriWithoutQuery.match(/\.([a-zA-Z0-9]{1,8})$/);
  return extensionMatch?.[1].toLowerCase() ?? 'jpg';
}

function createObjectName(index: number, imageUri: string) {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${index}-${randomPart}.${sanitizeExtension(imageUri)}`;
}

export async function persistMemoImages(memoId: string, imageUris: string[]) {
  if (imageUris.length === 0) return [];
  ensureObjectsDirectory();
  const memoObjectsDirectory = new Directory(objectsDirectory, memoId);
  memoObjectsDirectory.create({ intermediates: true, idempotent: true });

  const objectKeys: string[] = [];
  try {
    for (const [index, imageUri] of imageUris.entries()) {
      const objectName = createObjectName(index, imageUri);
      const objectFile = new File(memoObjectsDirectory, objectName);
      objectKeys.push(`${memoId}/${objectName}`);
      await new File(imageUri).copy(objectFile);
    }
    return objectKeys;
  } catch (error) {
    // REQ-047: failed edits must not delete objects referenced by older operations.
    for (const objectKey of objectKeys) {
      const file = new File(resolveObjectUri(objectKey));
      if (file.exists) file.delete();
    }
    throw new Error(`Failed to persist images for memo ${memoId}`, { cause: error });
  }
}

export function resolveObjectUri(objectKey: string) {
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.[a-zA-Z0-9]{1,8}$/.test(objectKey)) {
    throw new Error(`Invalid memo image object key: ${objectKey}`);
  }
  return new File(objectsDirectory, ...objectKey.split('/')).uri;
}

export function deleteMemoObjects(memoId: string) {
  const memoObjectsDirectory = new Directory(objectsDirectory, memoId);
  if (memoObjectsDirectory.exists) memoObjectsDirectory.delete();
}

export function deleteObjectKeys(objectKeys: string[]) {
  for (const objectKey of objectKeys) {
    const file = new File(resolveObjectUri(objectKey));
    if (file.exists) file.delete();
  }
}

export function persistDownloadedObject(memoId: string, extension: string, bytes: Uint8Array) {
  if (!/^[a-zA-Z0-9-]+$/.test(memoId) || !/^[a-zA-Z0-9]{1,8}$/.test(extension) || bytes.length === 0) {
    throw new Error('Invalid downloaded memo object');
  }
  ensureObjectsDirectory();
  const memoDirectory = new Directory(objectsDirectory, memoId);
  memoDirectory.create({ intermediates: true, idempotent: true });
  const objectName = createObjectName(0, `remote.${extension}`);
  const objectKey = `${memoId}/${objectName}`;
  new File(memoDirectory, objectName).write(bytes);
  return objectKey;
}
