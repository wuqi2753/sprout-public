// REQ-069: docs/stories/v0.2.0/REQ-069-edit-memo-time.md
export type MemoTimeParts = [number, number, number, number, number, number];
export function memoTimeParts(date: Date): MemoTimeParts {
  if (Number.isNaN(date.getTime())) throw new Error('记录时间无效');
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
}
export function daysInMemoMonth(year: number, month: number) { return new Date(year, month, 0).getDate(); }
export function changeMemoTimePart(parts: MemoTimeParts, column: number, value: number): MemoTimeParts {
  const next: MemoTimeParts = [...parts];
  next[column] = value;
  next[2] = Math.min(next[2], daysInMemoMonth(next[0], next[1]));
  return next;
}
export function memoDateFromParts(parts: MemoTimeParts) {
  const [year, month, day, hour, minute, second] = parts;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  if (memoTimeParts(date).some((part, index) => part !== parts[index])) throw new Error('所选日期或时间无效，请重新选择。');
  return date;
}
