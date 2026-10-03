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
      await new File(imageUri).copy(objectFile);
      objectKeys.push(`${memoId}/${objectName}`);
    }
    return objectKeys;
  } catch (error) {
    if (memoObjectsDirectory.exists) memoObjectsDirectory.delete();
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
