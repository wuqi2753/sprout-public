import { extractTags } from '@/memos';
import type { CreateMemoInput, Memo, MemoEditInput } from '@/types/memo';
import { createUuid } from '@/sync/uuid';
import { rememberRecordingStart } from '@/storage/recording-start';
import { earliestRecordingDate } from '@/storage/memo-statistics-rules';

let browserMemos: Memo[] = [];
let browserTrash: Memo[] = [];
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
  await rememberRecordingStart(browserMemos.map((memo) => memo.createdOn));
  return browserMemos;
}

export async function getMemo(id: string) {
  return browserMemos.find((memo) => memo.id === id);
}

export async function getTrashMemos() { return browserTrash; }

// REQ-043: Browser preview keeps visibility in memory, like its memo content.
export async function setMemoHidden(id: string, hidden: boolean) {
  if (typeof hidden !== 'boolean') throw new Error('Memo hidden must be a boolean');
  if (!browserMemos.some((memo) => memo.id === id)) throw new Error(`Cannot change visibility of missing memo: ${id}`);
  browserMemos = browserMemos.map((memo) => memo.id === id ? { ...memo, hidden } : memo);
}

export async function addMemo(input: CreateMemoInput) {
  earliestRecordingDate(null, [input.createdOn]);
  const content = input.content.trim();
  if (input.imageUris.length + (input.fileAttachments?.length ?? 0) > 5) throw new Error('图片和文件合计不能超过 5 个。');
  if (input.fileAttachments?.length) throw new Error('请使用手机 App 保存文件附件');
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
      fileAttachments: [],
    },
    ...browserMemos,
  ];
  await rememberRecordingStart([input.createdOn]);
}

export async function updateMemoContent(id: string, content: string, savedAt: Date) {
  const existingMemo = browserMemos.find((memo) => memo.id === id);
  if (!existingMemo) throw new Error(`Cannot update missing memo: ${id}`);
  browserMemos = browserMemos.map((memo) =>
    memo.id === id ? { ...memo, content: content.trim(), savedAt, tags: extractTags(content), synced: false } : memo,
  );
}

export async function deleteMemo(id: string) {
  await getMemos();
  if (!browserMemos.some((memo) => memo.id === id)) throw new Error(`Cannot delete missing memo: ${id}`);
  const memo = browserMemos.find((entry) => entry.id === id)!;
  browserMemos = browserMemos.filter((entry) => entry.id !== id);
  if (!memo.hidden) browserTrash = [{ ...memo, deletedAt: new Date() }, ...browserTrash];
}

export async function restoreMemo(id: string) {
  const memo = browserTrash.find((entry) => entry.id === id);
  if (!memo) throw new Error(`Cannot restore missing trash memo: ${id}`);
  browserTrash = browserTrash.filter((entry) => entry.id !== id);
  browserMemos = [{ ...memo, deletedAt: undefined, expiresAt: undefined }, ...browserMemos];
}

export async function purgeMemo(id: string) {
  if (!browserTrash.some((entry) => entry.id === id)) throw new Error(`Cannot purge missing trash memo: ${id}`);
  browserTrash = browserTrash.filter((entry) => entry.id !== id);
}

export async function clearTrashMemos() { browserTrash = []; }

// REQ-047: browser preview supports the same draft save/cancel boundary.
// REQ-049: ordinary file persistence is available in the native App only.
export async function renameMemoFile(_id: string, _fileId: string, _filenameStem: string): Promise<void> {
  throw new Error('请使用手机 App 重命名文件附件。');
}

export async function removeMemoFile(_id: string, _fileId: string): Promise<void> {
  throw new Error('请使用手机 App 删除文件附件。');
}

export async function updateMemoDraft(id: string, draft: MemoEditInput, savedAt: Date) {
  if (draft.createdOn && Number.isNaN(draft.createdOn.getTime())) throw new Error('记录时间无效');
  if (!browserMemos.some((memo) => memo.id === id)) throw new Error(`Cannot update missing memo: ${id}`);
  const content = draft.content.trim();
  if (!content && !draft.imageUris.length && !(draft.fileAttachments?.length)) throw new Error('记录内容不能为空');
  if (draft.imageUris.length + (draft.fileAttachments?.length ?? 0) > 5) throw new Error('附件数量或类型组合无效');
  if (draft.fileAttachments?.length) throw new Error('请使用手机 App 保存文件附件');
  if (Number.isNaN(savedAt.getTime())) throw new Error('保存时间无效');
  browserMemos = browserMemos.map((memo) => memo.id === id
    ? { ...memo, content, createdOn: draft.createdOn ?? memo.createdOn, imageUris: [...draft.imageUris], savedAt, tags: extractTags(content), synced: false } : memo);
}
