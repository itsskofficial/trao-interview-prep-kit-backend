import { categoryFor, type DraftQuestion } from "../generation/questions";
import type { Requirement } from "../kit/schema";

/** Requirements that no question references. Set arithmetic: this is never the model's call. */
export function findUncovered(requirements: Requirement[], questions: Array<{ requirement_ids: string[] }>): Requirement[] {
  const covered = new Set(questions.flatMap((question) => question.requirement_ids));
  return requirements.filter((requirement) => !covered.has(requirement.id));
}

const FALLBACK_PROMPT: Record<Requirement["kind"], (text: string) => string> = {
  technical: (text) =>
    `The posting asks for: "${text}". Walk me through your hands-on experience with it: what you built, what went wrong, and how you fixed it.`,
  behavioural: (text) =>
    `The posting asks for: "${text}". Tell me about a specific time that shows this. What was the situation, what did you do, and what was the result?`,
  domain: (text) =>
    `The posting asks for: "${text}". Explain what you know about it, where you have applied it, and what you would want to learn first in this role.`,
};

/**
 * The backstop. If the model never produces a question for a must-have
 * requirement, code writes a plain one, so a kit cannot ship with a must-have
 * uncovered.
 */
export function fallbackQuestion(requirement: Requirement): DraftQuestion {
  return {
    requirement_ids: [requirement.id],
    category: categoryFor(requirement),
    prompt: FALLBACK_PROMPT[requirement.kind](requirement.text),
    answer_outline:
      "Pick one concrete example. State the context and your role, the decisions you made and why, the measurable outcome, and what you would do differently.",
    difficulty: 2,
    origin: "fallback",
  };
}

export const MAX_COVERAGE_PASSES = 3;

export interface CoverageResult {
  added: DraftQuestion[];
  /** How many times coverage was checked, counting the check of the first draft. */
  passes: number;
  /** What is still uncovered at the end. Never contains a must-have requirement. */
  uncovered: Requirement[];
}

/**
 * Check, generate for the gaps only, check again.
 *
 * Stops when no must-have is uncovered, when a pass closes nothing (asking the
 * same model the same thing again is wasted quota), or after MAX_COVERAGE_PASSES
 * checks. Nice-to-have gaps get one attempt, in the first gap-closing pass.
 * Whatever must-have is still open then gets a fallback question.
 */
export async function closeCoverageGaps(
  requirements: Requirement[],
  firstDraft: Array<{ requirement_ids: string[] }>,
  generateForGaps: (gaps: Requirement[]) => Promise<DraftQuestion[]>,
): Promise<CoverageResult> {
  const added: DraftQuestion[] = [];
  let passes = 1;
  let gaps = findUncovered(requirements, firstDraft);

  while (passes < MAX_COVERAGE_PASSES) {
    const targets = passes === 1 ? gaps : gaps.filter(isMust);
    if (targets.length === 0) break;

    const generated = await generateForGaps(targets).catch(() => []);
    added.push(...generated);
    passes++;

    const remaining = findUncovered(requirements, [...firstDraft, ...added]);
    const closedNothing = remaining.length === gaps.length;
    gaps = remaining;
    if (closedNothing) break;
  }

  const fallbacks = gaps.filter(isMust).map(fallbackQuestion);
  added.push(...fallbacks);
  return { added, passes, uncovered: gaps.filter((requirement) => !isMust(requirement)) };
}

function isMust(requirement: Requirement): boolean {
  return requirement.priority === "must";
}
