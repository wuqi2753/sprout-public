// REQ-059: docs/stories/v0.2.0/REQ-059-sidebar-tag-order.md
export function readTagOrder(value: string | null): string[] {
  if (value === null) return [];
  const names: unknown = JSON.parse(value);
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name.trim()) || new Set(names).size !== names.length) {
    throw new Error('Stored tag order must contain unique, nonempty tag names');
  }
  return names;
}

export function orderTags<T extends { name: string; count: number }>(tags: readonly T[], names: readonly string[]): T[] {
  const positions = new Map(names.map((name, index) => [name, index]));
  return [...tags].sort((first, second) =>
    (positions.get(first.name) ?? Infinity) - (positions.get(second.name) ?? Infinity)
    || second.count - first.count || first.name.localeCompare(second.name));
}

export function tagOrderToSave(names: readonly string[], defaultNames: readonly string[]): string[] {
  return names.length === defaultNames.length && names.every((name, index) => name === defaultNames[index])
    ? [] : [...names];
}

export function moveTag(names: readonly string[], from: number, to: number): string[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= names.length || to >= names.length) {
    throw new Error('Tag move positions must be within the tag list');
  }
  const reordered = [...names];
  reordered.splice(to, 0, reordered.splice(from, 1)[0]);
  return reordered;
}
