// REQ-041: preview a disposable copy, never expose the durable original to editors.
import { Directory, File, Paths } from 'expo-file-system';
import ExpoQuickLook from '@magrinj/expo-quick-look';
import { AppState, Platform } from 'react-native';
import { createUuid } from '@/sync/uuid';
import type { FileAttachment } from '@/types/attachment';

export async function openFileAttachment(attachment: FileAttachment) {
  const source = new File(attachment.uri);
  if (!source.exists) throw new Error('本地文件不存在，无法查看。');
  const directory = new Directory(Paths.cache, 'file-previews', createUuid());
  directory.create({ intermediates: true, idempotent: true });
  const copy = new File(directory, `document.${attachment.name.split('.').at(-1)?.toLowerCase()}`);
  let subscription: ReturnType<typeof AppState.addEventListener> | undefined;
  try {
    await source.copy(copy);
    if (!await ExpoQuickLook.canPreview(copy.uri)) throw new Error('手机没有可用的阅读器，可安装 WPS 或 PDF 阅读器后再查看。文件仍已保存。');
    if (Platform.OS === 'android') {
      // Register before launch: a fast chooser cancellation can resume immediately.
      subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          subscription?.remove();
          if (directory.exists) directory.delete();
        }
      });
    }
    await ExpoQuickLook.previewFile({ uri: copy.uri, chooserTitle: '选择文件阅读器', editingMode: 'disabled' });
    if (Platform.OS === 'ios' && directory.exists) directory.delete();
  } catch (error) {
    subscription?.remove();
    if (directory.exists) directory.delete();
    throw error;
  }
}
