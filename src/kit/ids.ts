/**
 * Hands out ids like q1, q2, ... continuing after the highest number already
 * in use, so an id is never given to two items.
 */
export function idAllocator(prefix: string, existingIds: Iterable<string> = [], floor = 0): () => string {
  let highest = floor;
  for (const id of existingIds) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return () => `${prefix}${++highest}`;
}
