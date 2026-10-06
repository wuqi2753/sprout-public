// REQ-055: app-private search history, isolated by memo partition.
import * as FileSystem from 'expo-file-system';
import { readSearchHistory, type SearchPartition } from './search-history-rules';

export async function getSearchHistory(partition: SearchPartition): Promise<string[]> {
  const file = new FileSystem.File(FileSystem.Paths.document, `search-history-${partition}.json`);
  return readSearchHistory(file.exists ? await file.text() : null);
}

export async function saveSearchHistory(partition: SearchPartition, keywords: string[]): Promise<void> {
  const serialized = JSON.stringify(keywords);
  readSearchHistory(serialized);
  new FileSystem.File(FileSystem.Paths.document, `search-history-${partition}.json`).write(serialized);
}
