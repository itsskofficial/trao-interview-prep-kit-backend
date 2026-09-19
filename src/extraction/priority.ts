import type { Priority } from "../kit/schema";
import { normalise } from "./evidence";

const NICE = [
  "nice to have", "nice-to-have", "bonus", "preferred", "preferably", "a plus", "plus point", "ideally",
  "desirable", "desired", "advantage", "optional", "would be great", "good to have", "not required",
  "extra credit",
];

/** Strong enough to trust on a single line, even under a "nice to have" heading. */
const MUST_ON_LINE = ["required", "must", "essential", "mandatory", "minimum", "need to", "you need", "needs to"];

/** Section headings that introduce must-haves. Too loose to apply to an individual line. */
const MUST_IN_HEADING = [
  ...MUST_ON_LINE, "requirement", "qualification", "you have", "you'll have", "you will have", "what you bring",
  "what you'll bring", "looking for", "who you are", "about you", "you should have",
];

function signal(text: string, mustPhrases: string[]): Priority | undefined {
  const normalised = normalise(text);
  // Checked first: "GraphQL is a plus" under a Requirements heading is still a nice-to-have.
  if (NICE.some((phrase) => normalised.includes(phrase))) return "nice";
  if (mustPhrases.some((phrase) => normalised.includes(phrase))) return "must";
  return undefined;
}

const BULLET = /^\s*(?:[-*•●◦⁃·]|\d+[.)])\s+/;

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.length <= 80 && !BULLET.test(line) && !/[.!?]$/.test(trimmed);
}

/**
 * Decides must or nice from how the posting words it: first the line the
 * evidence sits on, then the heading above it. The model's own label is used
 * only when the posting gives no signal either way.
 */
export function decidePriority(description: string, evidence: string, modelPriority: Priority): Priority {
  const lines = description.split(/\r?\n/);
  const needle = normalise(evidence);
  const index = lines.findIndex((line) => {
    const candidate = normalise(line);
    return candidate.length > 0 && (candidate.includes(needle) || (candidate.length > 5 && needle.startsWith(candidate)));
  });

  // A stub may put everything on one line ("Required: React. Bonus: GraphQL."), so the
  // scope is the sentence holding the evidence, not the whole line.
  const sentences = index === -1 ? [] : lines[index]!.split(/(?<=[.;!?])\s+/);
  const sentence = sentences.find((candidate) => normalise(candidate).includes(needle));
  const fromSentence = signal(evidence, MUST_ON_LINE) ?? signal(sentence ?? evidence, MUST_ON_LINE);
  if (fromSentence) return fromSentence;

  for (let i = index - 1; i >= 0; i--) {
    if (isHeading(lines[i]!)) return signal(lines[i]!, MUST_IN_HEADING) ?? modelPriority;
  }
  return modelPriority;
}
