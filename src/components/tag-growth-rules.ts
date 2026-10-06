// REQ-063: real ordinary memo counts, grouped by local creation date.
type GrowthMemo = { createdOn: Date; hidden?: boolean; tags: string[] };

function localDayNumber(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new Error('生长曲线：createdOn日期无效。');
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}

export function tagGrowthRecords(memos: GrowthMemo[], today = new Date()) {
  const todayNumber = localDayNumber(today);
  const ordinaryMemos = memos.filter((memo) => !memo.hidden);
  const tagCounts = new Map<string, number>();
  for (const memo of ordinaryMemos) {
    if (localDayNumber(memo.createdOn) > todayNumber) throw new Error('生长曲线：createdOn日期晚于今天。');
    for (const tag of new Set(memo.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const tags = [...tagCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const tagPositions = new Map(tags.map((tag, index) => [tag.name, index + 1]));
  const days = new Map<number, { date: Date; counts: number[] }>();
  for (const memo of ordinaryMemos) {
    const dayNumber = localDayNumber(memo.createdOn);
    let day = days.get(dayNumber);
    if (!day) {
      day = { date: new Date(memo.createdOn.getFullYear(), memo.createdOn.getMonth(), memo.createdOn.getDate()), counts: Array(tags.length + 1).fill(0) };
      days.set(dayNumber, day);
    }
    day.counts[0]++;
    for (const tag of new Set(memo.tags)) day.counts[tagPositions.get(tag)!]++;
  }
  return {
    tagNames: ['全部', ...tags.map((tag) => tag.name)],
    tagTotals: [ordinaryMemos.length, ...tags.map((tag) => tag.count)],
    recordedDays: [...days.values()].sort((a, b) => a.date.getTime() - b.date.getTime()),
  };
}
