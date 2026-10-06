// REQ-061: docs/stories/v0.2.0/REQ-061-memo-statistics.md
type StatisticsMemo = { createdOn: Date; hidden?: boolean; tags: string[] };

function localDayNumber(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new Error('记录统计：createdOn 日期无效。');
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}

export function earliestRecordingDate(saved: string | null, dates: Date[], today = new Date()): string | null {
  const todayNumber = localDayNumber(today);
  let earliest = saved === null ? null : new Date(saved);
  for (const date of [...(earliest ? [earliest] : []), ...dates]) {
    if (localDayNumber(date) > todayNumber) throw new Error('记录统计：createdOn 日期晚于今天。');
    if (earliest === null || date.getTime() < earliest.getTime()) earliest = date;
  }
  return earliest?.toISOString() ?? null;
}

export function calculateMemoStatistics(memos: StatisticsMemo[], firstRecordedAt: string | null, today = new Date()) {
  const earliest = earliestRecordingDate(firstRecordedAt, memos.map((memo) => memo.createdOn), today);
  const ordinaryMemos = memos.filter((memo) => !memo.hidden);
  return {
    memoCount: ordinaryMemos.length,
    tagCount: new Set(ordinaryMemos.flatMap((memo) => memo.tags)).size,
    recordingDays: earliest === null ? 0 : localDayNumber(today) - localDayNumber(new Date(earliest)) + 1,
  };
}
