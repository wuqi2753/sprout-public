// REQ-040 / REQ-041: ordinary files are distinct from photo attachments.
export type FileAttachment = {
  uri: string;
  name: string;
  mediaType: string;
  size: number;
};

export type StoredFileAttachment = FileAttachment & {
  id: string;
  objectKey: string;
  sha256: string;
};
