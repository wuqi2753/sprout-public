// REQ-055: local recent search contract.
export type SearchPartition = 'ordinary' | 'hidden';

export function readSearchHistory(serialized: string | null): string[] {
  if (serialized === null) return [];
  const keywords: unknown = JSON.parse(serialized);
  if (!Array.isArray(keywords) || keywords.length > 10 || keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim() || keyword !== keyword.trim()) || new Set(keywords).size !== keywords.length) {
    throw new Error('Search history must contain at most 10 unique nonempty trimmed keywords');
  }
  return keywords;
}

export function addRecentSearch(keywords: string[], query: string): string[] {
  const keyword = query.trim();
  return keyword ? [keyword, ...keywords.filter((saved) => saved !== keyword)].slice(0, 10) : keywords;
}
