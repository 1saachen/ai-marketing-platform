/** JSONB can reorder object keys. Business content equality must retain array order only. */
export function cloneContentSignature(value: unknown): string | undefined {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, ordered(child)]),
      );
    return item;
  };
  return JSON.stringify(ordered(value));
}

export const sameCloneContent = (left: unknown, right: unknown): boolean =>
  cloneContentSignature(left) === cloneContentSignature(right);
