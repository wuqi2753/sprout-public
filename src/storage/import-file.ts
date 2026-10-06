import type { FileAttachment } from '@/types/attachment';

export async function chooseFileAttachments(_remainingSlots: number): Promise<FileAttachment[]> {
  throw new Error('请使用手机 App 导入文件。');
}

export async function copyIncomingFile(_uri: string, _name: string, _size?: number): Promise<FileAttachment> {
  throw new Error('请使用手机 App 导入文件。');
}

export function discardImportedFile(attachment: FileAttachment | undefined) {
  if (attachment) throw new Error('浏览器预览不支持本地文件导入。');
}

export function discardPrivateCacheCopy(_uri: string) {
  return undefined;
}

export function discardAbandonedAttachmentCaches() {
  return undefined;
}
