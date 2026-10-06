// REQ-040: reject links before resolving, so receiving a URL never downloads it.
import { useEffect, useRef } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import * as Sharing from 'expo-sharing';
import { copyIncomingFile, discardImportedFile, discardPrivateCacheCopy, discardAbandonedAttachmentCaches } from '@/storage/import-file';
import type { FileAttachment } from '@/types/attachment';

export function useSharedFile(onFile: (files: FileAttachment[]) => void, onError: (error: unknown) => void) {
  const callbacks = useRef({ onFile, onError });
  useEffect(() => { callbacks.current = { onFile, onError }; }, [onFile, onError]);
  useEffect(() => {
    try { discardAbandonedAttachmentCaches(); }
    catch (error) { callbacks.current.onError(error); }
    let receiving = false;
    let active = true;
    async function receiveFile() {
      if (receiving) return;
      receiving = true;
      let consumed = false;
      const resolvedUris: string[] = [];
      const attachments: FileAttachment[] = [];
      try {
        const payloads = Sharing.getSharedPayloads();
        if (payloads.length === 0) return;
        consumed = true;
        if (payloads.length > 5) throw new Error('图片和文件合计最多 5 个。');
        if (payloads.some((payload) => !/^(file|content):\//i.test(payload.value))) throw new Error('请先下载文件，再分享给 Sprout。');
        const resolved = await Sharing.getResolvedSharedPayloadsAsync();
        resolvedUris.push(...resolved.flatMap((file) => file.contentUri ? [file.contentUri] : []));
        if (resolved.length !== payloads.length) throw new Error('分享文件数量不一致，请从文件选择器重试。');
        // Read the original Android provider URI ourselves: the SDK resolver copies to a
        // reused filename and may return it even after a provider read failure.
        for (const [index, file] of resolved.entries()) {
          if (!file.contentUri || !file.originalName) throw new Error('无法读取分享文件，请从文件选择器重试。');
          attachments.push(await copyIncomingFile(Platform.OS === 'android' ? payloads[index].value : file.contentUri, file.originalName, file.contentSize ?? undefined));
        }
        if (active) callbacks.current.onFile(attachments);
        else attachments.forEach(discardImportedFile);
      } catch (error) {
        attachments.forEach(discardImportedFile);
        if (active) callbacks.current.onError(error);
      } finally {
        resolvedUris.forEach(discardPrivateCacheCopy);
        if (consumed) Sharing.clearSharedPayloads();
        receiving = false;
      }
    }
    void receiveFile();
    const appState = AppState.addEventListener('change', (state) => { if (state === 'active') void receiveFile(); });
    const links = Linking.addEventListener('url', () => { void receiveFile(); });
    return () => { active = false; appState.remove(); links.remove(); };
  }, []);
}
