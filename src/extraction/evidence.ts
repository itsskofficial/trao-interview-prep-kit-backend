/** Lowercase, straighten quotes and dashes, drop bullet markers, collapse whitespace. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/[•●◦⁃·*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "for", "from", "has", "have", "in", "is", "of", "on", "or",
  "our", "that", "the", "to", "we", "will", "with", "you", "your", "experience", "strong", "good", "knowledge",
]);

export function significantWords(text: string): string[] {
  return normalise(text)
    .split(/[^a-z0-9+#.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** The quote must be real text from the description, and long enough to mean something. */
export function isQuotedFrom(description: string, quote: string): boolean {
  const needle = normalise(quote);
  return needle.length >= 2 && normalise(description).includes(needle);
}

/** Share of the claim's significant words that also appear in the supporting text. */
export function wordOverlap(claim: string, support: string): number {
  const words = significantWords(claim);
  if (words.length === 0) return 0;
  const supportWords = new Set(significantWords(support));
  return words.filter((word) => supportWords.has(word)).length / words.length;
}
