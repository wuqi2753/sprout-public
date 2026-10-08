import type { FileAttachment, StoredFileAttachment } from './attachment';

// REQ-052: docs/stories/v0.2.0/REQ-052-mixed-memo-attachments.md

export type Memo = {
  id: string;
  content: string;
  createdOn: Date;
  savedAt: Date;
  tags: string[];
  imageUris: string[];
  synced: boolean;
  hidden?: boolean;
  deletedAt?: Date;
  expiresAt?: Date;
  fileAttachments: StoredFileAttachment[];
};

export type CreateMemoInput = {
  id: string;
  content: string;
  createdOn: Date;
  imageUris: string[];
  fileAttachments?: FileAttachment[];
};

// REQ-047: a complete editor draft, committed only on Save.
export type MemoEditInput = {
  content: string;
  imageUris: string[];
  fileAttachments?: FileAttachment[];
};
