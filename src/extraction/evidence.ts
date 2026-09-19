/**
 * Text as it should be compared, not as it happened to be typed. Applied to
 * both the posting and the quote, so removing a character is always safe.
 * Markdown emphasis, code ticks and link syntax are deleted rather than turned
 * into spaces: "**React**, TypeScript" must still match "React, TypeScript".
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[​-‍﻿]/g, "")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/…/g, "...")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [GraphQL](https://...) -> GraphQL
    .replace(/[*_`~]/g, "")
    .replace(/[•●◦⁃·]/g, " ")
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

/** Characters that are part of a word for our purposes: "c++", "c#" and ".net" are words. */
const WORD = "a-z0-9+#";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `phrase` appears in `text` as whole words. Both must already be
 * normalised. "go" is not in "good", and "java" is not in "javascript".
 */
export function containsPhrase(text: string, phrase: string): boolean {
  if (phrase.length === 0) return false;
  return new RegExp(`(?<![${WORD}])${escapeRegExp(phrase)}(?![${WORD}])`).test(text);
}

const squash = (text: string) => normalise(text).replace(new RegExp(`[^${WORD}]`, "g"), "");

/** The quote must be real text from the description, and long enough to mean something. */
export function isQuotedFrom(description: string, quote: string): boolean {
  const needle = normalise(quote);
  if (needle.length < 2) return false;
  if (containsPhrase(normalise(description), needle)) return true;
  // Punctuation and spacing differ in ways no list of rules will ever finish covering. For a quote long
  // enough that a chance match is implausible, compare the letters and digits alone.
  const squashed = squash(quote);
  return squashed.length >= 12 && squash(description).includes(squashed);
}

/** Share of the claim's significant words that also appear in the supporting text. */
export function wordOverlap(claim: string, support: string): number {
  const words = significantWords(claim);
  if (words.length === 0) return 0;
  const supportWords = new Set(significantWords(support));
  return words.filter((word) => supportWords.has(word)).length / words.length;
}
