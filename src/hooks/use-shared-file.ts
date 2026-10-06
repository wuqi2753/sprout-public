import type { FileAttachment } from '@/types/attachment';

// Native sharing is unavailable in the browser preview.
export function useSharedFile(_onFile: (files: FileAttachment[]) => void, _onError: (error: unknown) => void) {
  return undefined;
}
