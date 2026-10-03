export function formatMemoTime(date: Date) {
  if (Number.isNaN(date.getTime())) throw new Error(`Cannot format invalid memo date: ${date}`);

  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function extractTags(content: string) {
  return [...content.matchAll(/#([^\s#]+)/g)].map((match) => match[1]);
}
