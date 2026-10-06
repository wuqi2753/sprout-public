import type { FileAttachment } from '@/types/attachment';

export async function openFileAttachment(_attachment: FileAttachment) {
  throw new Error('请使用手机 App 查看文件。');
}
