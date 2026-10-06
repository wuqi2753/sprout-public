// REQ-062: local-date grid, independent of elapsed hours and filters.
export function recordingDateKey(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new Error('热力图：记录日期无效。');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function heatmapIntensity(count: number) {
  if (!Number.isInteger(count) || count < 0) throw new Error('热力图：笔记数量必须是非负整数。');
  return count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;
}
export function recordingHeatmap(dates: Date[], today = new Date()) {
  const counts = new Map<string, number>();
  const todayKey = recordingDateKey(today);
  for (const date of dates) {
    const key = recordingDateKey(date);
    if (key > todayKey) throw new Error('热力图：记录日期晚于今天。');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const mondayOffset = (today.getDay() + 6) % 7;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset - 12 * 7);
  return Array.from({ length: 13 }, (_, week) => Array.from({ length: 7 }, (_, weekday) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + week * 7 + weekday);
    const key = recordingDateKey(date);
    const count = counts.get(key) ?? 0;
    return { date, key, count, intensity: heatmapIntensity(count), future: key > todayKey, today: key === todayKey };
  }));
}
