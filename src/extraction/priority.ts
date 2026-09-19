import type { Priority } from "../kit/schema";
import { containsPhrase, normalise } from "./evidence";

/** Wording that marks something as a bonus. Whole words only: "desired" is not in "undesired". */
const NICE = [
  /\bnice[- ]to[- ]have\b/, /\bbonus\b/, /\bpreferred\b/, /\bpreferably\b/, /\bideally\b/, /\bdesirable\b/, /\bdesired\b/,
  /\badvantage(ous)?\b/, /\boptional(ly)?\b/, /\bwould be (great|nice|good)\b/, /\bgood to have\b/, /\bnot required\b/,
  /\bnot essential\b/, /\bextra credit\b/, /\bpluses\b/, /\bplus points?\b/,
  // "is a plus", "a big plus", "would be a strong plus" - but not "Python plus SQL".
  /\b(a|an)\s+(\w+\s+)?plus\b/,
];

/** Strong enough to trust on a single line, even under a "nice to have" heading. */
const MUST_ON_LINE = [/\brequired\b/, /\bmust\b/, /\bessential\b/, /\bmandatory\b/, /\bminimum\b/, /\bneed to\b/, /\byou need\b/, /\bneeds to\b/];

/** Section headings that introduce must-haves. Too loose to apply to an individual line. */
const MUST_IN_HEADING = [
  ...MUST_ON_LINE, /\brequirements?\b/, /\bqualifications?\b/, /\byou have\b/, /\byou'll have\b/, /\byou will have\b/,
  /\bwhat you('ll)? bring\b/, /\blooking for\b/, /\bwho you are\b/, /\babout you\b/, /\byou should have\b/,
];

const firstMatch = (text: string, patterns: RegExp[]) =>
  patterns.reduce((earliest, pattern) => {
    const index = text.search(pattern);
    return index !== -1 && index < earliest ? index : earliest;
  }, Number.POSITIVE_INFINITY);

/**
 * Must or nice from one stretch of text. When it carries both kinds of wording
 * the one that comes first wins, because that is how postings are written:
 * "Bachelor's degree required, Master's preferred" is a must-have with a
 * preference attached, and "not required" starts before "required" does.
 */
function signal(text: string, mustPatterns: RegExp[]): Priority | undefined {
  const normalised = normalise(text);
  const nice = firstMatch(normalised, NICE);
  const must = firstMatch(normalised, mustPatterns);
  if (nice === Number.POSITIVE_INFINITY && must === Number.POSITIVE_INFINITY) return undefined;
  return must < nice ? "must" : "nice";
}

const BULLET = /^\s*(?:[-*•●◦⁃·]|\d+[.)])\s+/;

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.length <= 80 && !BULLET.test(line) && !/[.!?]$/.test(trimmed);
}

/** The line the evidence came from. A list item that is exactly the evidence beats a sentence that merely contains it. */
function findEvidenceLine(lines: string[], needle: string): number {
  const normalised = lines.map((line) => normalise(line.replace(BULLET, "")));
  const exact = normalised.findIndex((line) => line === needle || line.replace(/[.;,]$/, "") === needle);
  if (exact !== -1) return exact;
  const containing = normalised.findIndex((line) => containsPhrase(line, needle));
  if (containing !== -1) return containing;
  // Evidence that spans lines: the line it starts on.
  return normalised.findIndex((line) => line.length > 5 && needle.startsWith(line));
}

/**
 * Decides must or nice from how the posting words it: first the evidence and
 * the sentence it sits in, then the heading above it. The model's own label is
 * used only when the posting gives no signal either way.
 */
export function decidePriority(description: string, evidence: string, modelPriority: Priority): Priority {
  const lines = description.split(/\r?\n/);
  const needle = normalise(evidence);
  const index = findEvidenceLine(lines, needle);

  // A stub may put everything on one line ("Required: React. Bonus: GraphQL."), so the
  // scope is the sentence holding the evidence, not the whole line.
  const sentences = index === -1 ? [] : lines[index]!.split(/(?<=[.;!?])\s+/);
  const sentence = sentences.find((candidate) => containsPhrase(normalise(candidate), needle));
  const fromSentence = signal(evidence, MUST_ON_LINE) ?? signal(sentence ?? evidence, MUST_ON_LINE);
  if (fromSentence) return fromSentence;

  for (let i = index - 1; i >= 0; i--) {
    if (isHeading(lines[i]!)) return signal(lines[i]!, MUST_IN_HEADING) ?? modelPriority;
  }
  return modelPriority;
}
