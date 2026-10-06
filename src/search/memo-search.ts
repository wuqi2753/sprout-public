import type { Memo } from '../types/memo';

// REQ-055 / REQ-056: Local, timezone-aware search over an already authorized partition.
export type SearchDateRange = 'all' | 'week' | 'month' | 'custom';
export type SearchTagRange = 'all' | 'untagged' | 'include' | 'exclude';
export type SearchContentRange = 'all' | 'images' | 'files';
export type MemoSearchSort = 'created-desc' | 'created-asc' | 'edited-desc' | 'edited-asc';

export function sortSearchMemos(memos: Memo[], order: MemoSearchSort): Memo[] {
  const direction = order.endsWith('asc') ? 1 : -1;
  const dateField = order.startsWith('edited') ? 'savedAt' : 'createdOn';
  return [...memos].sort((first, second) => direction * (first[dateField].getTime() - second[dateField].getTime()));
}
export type MemoSearchFilters = {
  dateRange: SearchDateRange;
  startDate: string;
  endDate: string;
  tagRange: SearchTagRange;
  tags: string[];
  contentRange: SearchContentRange;
};

export function emptySearchFilters(): MemoSearchFilters {
  return { dateRange: 'all', startDate: '', endDate: '', tagRange: 'all', tags: [], contentRange: 'all' };
}

export function localDateLabel(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function readLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDateLabel(date) === value ? date : null;
}

export function searchFilterError(filters: MemoSearchFilters): string | undefined {
  if (filters.dateRange === 'custom') {
    if (!readLocalDate(filters.startDate) || !readLocalDate(filters.endDate)) return '请选择有效的开始和结束日期。';
    if (filters.startDate > filters.endDate) return '开始日期不能晚于结束日期。';
  }
  if ((filters.tagRange === 'include' || filters.tagRange === 'exclude') && filters.tags.length === 0) return '请至少选择一个指定标签。';
}

export function hasSearchFilters(filters: MemoSearchFilters): boolean {
  return filters.dateRange !== 'all' || filters.tagRange !== 'all' || filters.contentRange !== 'all';
}

export function matchesMemoSearch(memo: Memo, query: string, filters: MemoSearchFilters, today = new Date()): boolean {
  const error = searchFilterError(filters);
  if (error) throw new Error(error);
  const searchableText = `${memo.content}\n${memo.tags.map((tag) => `#${tag}`).join(' ')}`.toLocaleLowerCase();
  if (!query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every((keyword) => searchableText.includes(keyword))) return false;
  if (filters.contentRange === 'images' && memo.imageUris.length === 0) return false;
  if (filters.contentRange === 'files' && memo.fileAttachments.length === 0) return false;
  if (filters.tagRange === 'untagged' && memo.tags.length > 0) return false;
  if (filters.tagRange === 'include' || filters.tagRange === 'exclude') {
    const hasSelectedTag = filters.tags.some((selected) => memo.tags.some((tag) => tag === selected || tag.startsWith(`${selected}/`)));
    if ((filters.tagRange === 'include' && !hasSelectedTag) || (filters.tagRange === 'exclude' && hasSelectedTag)) return false;
  }
  if (filters.dateRange !== 'all') {
    let start: Date;
    let end: Date;
    if (filters.dateRange === 'custom') {
      start = readLocalDate(filters.startDate)!;
      end = readLocalDate(filters.endDate)!;
      end.setDate(end.getDate() + 1);
    } else if (filters.dateRange === 'week') {
      start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      start.setDate(start.getDate() - (start.getDay() + 6) % 7);
      end = new Date(start);
      end.setDate(end.getDate() + 7);
    } else {
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      end = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    }
    if (memo.createdOn < start || memo.createdOn >= end) return false;
  }
  return true;
}
