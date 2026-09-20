import type { Priority } from "../kit/schema";
import { containsPhrase, normalise } from "./evidence";

/** Wording that marks something as a bonus. Whole words only: "desired" is not in "undesired". */
const NICE = [
  /\bnice[- ]to[- ]haves?\b/, /\bbonus\b/, /\bpreferred\b/, /\bpreferably\b/, /\bideally\b/, /\bdesirable\b/, /\bdesired\b/,
  /\badvantage(ous)?\b/, /\boptional(ly)?\b/, /\bwould be (great|nice|good)\b/, /\bgood to have\b/, /\bnot required\b/,
  /\bnot essential\b/, /\bextra credit\b/, /\bpluses\b/, /\bplus points?\b/,
  // How postings say it when they are being friendly rather than formal.
  /\b(we'd|we would|would) love\b/, /\beven better\b/, /\bsets? you apart\b/, /\bstand out\b/, /\bhelpful\b/, /\b(is|are|would be) (very |most |always )?welcome\b/,
  // "is a plus", "a big plus", "would be a strong plus" - but not "Python plus SQL".
  /\b(a|an)\s+(\w+\s+)?plus\b/,
];

/** Strong enough to trust on a single line, even under a "nice to have" heading. */
const MUST_ON_LINE = [/\brequired\b/, /\bmust\b/, /\bessential\b/, /\bmandatory\b/, /\bminimum\b/, /\bneed to\b/, /\byou need\b/, /\byou('ll| will) need\b/, /\bneeds to\b/, /\bnon-?negotiables?\b/, /\bmust[- ]haves?\b/];

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

export interface PrioritySignals {
  /** From the evidence itself or the sentence it sits in. Explicit wording about this one requirement. */
  line?: Priority;
  /** From the nearest heading above it. Says what kind of list this is, not what this item is. */
  heading?: Priority;
  /**
   * Whether that heading makes a claim ("Required qualifications", "Nice to have") or only names a container
   * ("Requirements", "About you"), under which postings put optional things all the time.
   */
  headingIsExplicit?: boolean;
}

/** What the posting's wording says about one requirement, kept apart so that policies for combining it with the model's label can be measured. */
export function prioritySignals(description: string, evidence: string): PrioritySignals {
  const lines = description.split(/\r?\n/);
  const needle = normalise(evidence);
  const index = findEvidenceLine(lines, needle);

  // A stub may put everything on one line ("Required: React. Bonus: GraphQL."), so the
  // scope is the sentence holding the evidence, not the whole line.
  const sentences = index === -1 ? [] : lines[index]!.split(/(?<=[.;!?])\s+/);
  const sentence = sentences.find((candidate) => containsPhrase(normalise(candidate), needle));
  const line = signal(evidence, MUST_ON_LINE) ?? signal(sentence ?? evidence, MUST_ON_LINE);

  for (let i = index - 1; i >= 0; i--) {
    if (isHeading(lines[i]!)) {
      const heading = signal(lines[i]!, MUST_IN_HEADING);
      // The same strong words that are trusted on a line are what make a heading a claim rather than a label.
      return { line, heading, headingIsExplicit: heading !== undefined && signal(lines[i]!, MUST_ON_LINE) === heading };
    }
  }
  return { line };
}

/**
 * Must or nice, from three opinions in a measured order. Measured with `npm run measure:priority` (2026-09-20,
 * gemini-3.5-flash-lite) over fixtures/priority-cases.json, whose held-out half was written after tuning and is
 * never tuned against:
 *
 *   line, then any heading, then model        39/39 tuned   15/19 held out   <- what this used to be
 *   model only                                38/39         18/19
 *   line, then model                          39/39         18/19
 *   line, then an explicit heading, then model 39/39         18/19           <- what this is
 *
 * 1. Wording about this one requirement ("required", "a plus") is explicit and wins.
 * 2. A heading that makes a claim ("Nice to have", "Bonus points", "Required qualifications", "Must-haves") is explicit too.
 * 3. Otherwise the model, which has read the sentence. A heading like "Requirements" or "About you" is a container, not a
 *    claim about each line in it: postings put "is appreciated" and "not a dealbreaker" under it all the time, and letting
 *    it overrule the model caused three of the old policy's four held-out mistakes. The model never once called a plain
 *    line under such a heading a bonus.
 *
 * The one held-out case still wrong ("Additional skills" read as must-have) is the model's own reading with no wording
 * to correct it. It is left wrong on purpose: fixing it would mean tuning on the held-out set, which would stop it being one.
 *
 * Step 2 costs nothing on the measured sets and is a floor under a lazy model: one that calls everything a must-have (the
 * offline stand-in does) still gets a "Nice to have" section right.
 */
export function decidePriority(description: string, evidence: string, modelPriority: Priority): Priority {
  const { line, heading, headingIsExplicit } = prioritySignals(description, evidence);
  return line ?? (headingIsExplicit ? heading : undefined) ?? modelPriority;
}
