/**
 * The part of a long page worth showing a model.
 *
 * A handbook page about hiring can run to tens of thousands of characters, and
 * the stages a candidate goes through may be anywhere in it, between a
 * philosophy section and instructions for the company's own recruiters. Taking
 * the top of the page misses them, and so does the single densest stretch
 * (on PostHog's page that is a section on booking interviews in their
 * applicant-tracking system). So this keeps, from the whole page and in page
 * order, the lines that mention the terms at all. If that is still too long,
 * the lines that say least are dropped first. A page that fits is returned whole.
 */
export function processDigest(text: string, terms: { strong: string[]; weak: string[] }, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const scored = text.split("\n").map((line, index) => {
    const lower = line.toLowerCase();
    const count = (list: string[]) => list.filter((term) => lower.includes(term)).length;
    return { line, index, score: count(terms.strong) * 3 + count(terms.weak) };
  });

  const relevant = scored.filter((entry) => entry.score > 0);
  // A page that never mentions the terms: nothing to choose between, so the top of it.
  if (relevant.length === 0) return takeWholeLines(scored.map((entry) => entry.line), maxChars);

  // Drop the least informative lines (and, among equals, the latest) until the rest fits.
  const byWorth = [...relevant].sort((a, b) => b.score - a.score || a.index - b.index);
  const kept = new Set<number>();
  let used = 0;
  for (const entry of byWorth) {
    const cost = Math.min(entry.line.length, MAX_LINE_CHARS) + 1;
    if (used + cost > maxChars) continue;
    kept.add(entry.index);
    used += cost;
  }
  return relevant
    .filter((entry) => kept.has(entry.index))
    .map((entry) => entry.line.slice(0, MAX_LINE_CHARS))
    .join("\n");
}

/** One enormous paragraph should not crowd out everything else. */
const MAX_LINE_CHARS = 600;

function takeWholeLines(lines: string[], maxChars: number): string {
  const taken: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    taken.push(line);
    used += line.length + 1;
  }
  return taken.join("\n");
}
