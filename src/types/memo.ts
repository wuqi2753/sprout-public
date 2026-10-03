export type Memo = {
  id: string;
  content: string;
  createdOn: Date;
  savedAt: Date;
  tags: string[];
  imageUris: string[];
  synced: boolean;
};

export type CreateMemoInput = {
  id: string;
  content: string;
  createdOn: Date;
  imageUris: string[];
};
