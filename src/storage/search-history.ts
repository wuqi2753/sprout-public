// REQ-055: browser-local search history, isolated by memo partition.
import { readSearchHistory, type SearchPartition } from './search-history-rules';

export async function getSearchHistory(partition: SearchPartition): Promise<string[]> {
  return typeof window === 'undefined' ? [] : readSearchHistory(window.localStorage.getItem(`sprout.search-history.${partition}`));
}

export async function saveSearchHistory(partition: SearchPartition, keywords: string[]): Promise<void> {
  const serialized = JSON.stringify(keywords);
  readSearchHistory(serialized);
  window.localStorage.setItem(`sprout.search-history.${partition}`, serialized);
}
