export function formatMemoTime(date: Date) {
  if (Number.isNaN(date.getTime())) throw new Error(`Cannot format invalid memo date: ${date}`);

  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function extractTags(content: string) {
  return [...content.matchAll(/#([^\s#]+)/g)].map((match) => match[1]);
}

// REQ-009 / REQ-047: Share cursor-based tag matching between capture and editing.
export function findTagDraft(content: string, cursorPosition: number) {
  const contentBeforeCursor = content.slice(0, cursorPosition);
  const match = contentBeforeCursor.match(/(^|\s)#([^\s#]*)$/);
  if (!match) return null;
  return { query: match[2], start: contentBeforeCursor.length - match[2].length - 1, end: cursorPosition };
}
