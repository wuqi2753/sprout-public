import { extractTags } from '@/memos';
import type { CreateMemoInput, Memo } from '@/types/memo';
import { createUuid } from '@/sync/uuid';

let browserMemos: Memo[] = [];
let welcomeMemoInitialized = false;

// REQ-039: Browser preview follows the same once-per-local-data behavior.
export async function initializeWelcomeMemo() {
  if (welcomeMemoInitialized) return;
  if (browserMemos.length === 0) {
    await addMemo({ id: createUuid(), content: '#开心 欢迎来到 Sprout!', createdOn: new Date(), imageUris: [] });
  }
  welcomeMemoInitialized = true;
}

export async function getMemos() {
  return browserMemos;
}

export async function getMemo(id: string) {
  return browserMemos.find((memo) => memo.id === id);
}

export async function addMemo(input: CreateMemoInput) {
  const content = input.content.trim();
  if (!content && input.imageUris.length === 0) throw new Error('Cannot save a memo without text or images');
  browserMemos = [
    {
      id: input.id,
      content,
      createdOn: input.createdOn,
      savedAt: input.createdOn,
      tags: extractTags(content),
      imageUris: input.imageUris,
      synced: false,
    },
    ...browserMemos,
  ];
}

export async function updateMemoContent(id: string, content: string, savedAt: Date) {
  const existingMemo = browserMemos.find((memo) => memo.id === id);
  if (!existingMemo) throw new Error(`Cannot update missing memo: ${id}`);
  browserMemos = browserMemos.map((memo) =>
    memo.id === id ? { ...memo, content: content.trim(), savedAt, tags: extractTags(content), synced: false } : memo,
  );
}

export async function deleteMemo(id: string) {
  if (!browserMemos.some((memo) => memo.id === id)) throw new Error(`Cannot delete missing memo: ${id}`);
  browserMemos = browserMemos.filter((memo) => memo.id !== id);
}
