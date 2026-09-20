import { z } from "zod";
import type { Config } from "../config";
import type { Kit } from "../kit/schema";
import type { LlmClient } from "../llm/types";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../llm/untrusted";

/**
 * Whether a kit is structurally right is decided by code, everywhere else in this repository.
 * Whether its questions are any good has no right answer a program can check, so this asks a
 * model, against a written rubric, and then checks the judge before believing it.
 *
 * It is an offline development tool. It is never part of the pipeline or of `evaluate`: a kit's
 * content is never accepted or rejected on a model's opinion of it.
 */

export const QUESTION_DIMENSIONS = ["relevance", "specificity", "difficulty_fit", "outline"] as const;
export const FLASHCARD_DIMENSIONS = ["correctness", "clarity"] as const;
export type QuestionDimension = (typeof QUESTION_DIMENSIONS)[number];
export type FlashcardDimension = (typeof FLASHCARD_DIMENSIONS)[number];

export const QUESTION_RUBRIC = `You are reviewing interview preparation questions written for one job posting. Score each question from 1 to 5 on four dimensions. Be strict: 3 is an acceptable question, 5 is rare.

relevance: does answering it show whether the candidate meets the requirement(s) it is linked to?
  1 = has nothing to do with the linked requirement. 3 = about the right subject, but a candidate could answer well without having the skill. 5 = cannot be answered well without exactly the experience the requirement asks for.
specificity: is it a concrete question an interviewer would really ask?
  1 = generic filler ("Tell me about X"). 3 = a real question, but textbook. 5 = a concrete scenario with constraints that force trade-offs.
difficulty_fit: does the stated difficulty (1 warm-up, 2 standard, 3 hard) match the question and the role's seniority?
  1 = badly mislabelled. 3 = roughly right. 5 = exactly right.
outline: would the answer outline help someone prepare a strong answer?
  1 = empty, wrong or restates the question. 3 = names the right topics. 5 = names the topics, the trade-offs and what separates a strong answer from a weak one.

For every item give "reason" first, one sentence on its main weakness or strength, and then the four scores. Judge each item on its own. Do not reward length.
${UNTRUSTED_CONTENT_RULE}`;

export const FLASHCARD_RUBRIC = `You are reviewing flashcards written to prepare for an interview. Score each card from 1 to 5 on two dimensions. Be strict.

correctness: is the back of the card factually right and an answer to the front?
  1 = wrong, or answers a different question. 3 = right but loose or incomplete in a way that could mislead. 5 = right and precise.
clarity: can it be recalled and checked in a few seconds?
  1 = vague or an essay. 3 = usable. 5 = one crisp fact or a short list.

For every item give "reason" first, one sentence, and then the two scores.
${UNTRUSTED_CONTENT_RULE}`;

const score = z.number().int().min(1).max(5);
const QuestionScores = z.object({ items: z.array(z.object({ id: z.string(), reason: z.string(), relevance: score, specificity: score, difficulty_fit: score, outline: score })) });
const FlashcardScores = z.object({ items: z.array(z.object({ id: z.string(), reason: z.string(), correctness: score, clarity: score })) });

export interface JudgedItem {
  kind: "question" | "flashcard";
  /** The kit's own id, or "canary-…" for an item planted to test the judge. */
  ref: string;
  canary: boolean;
  /** For a planted item: the dimension it was built to fail. */
  target?: string;
  text: string;
  reason: string;
  scores: Record<string, number>;
  mean: number;
}

export interface KitJudgement {
  id: string;
  items: JudgedItem[];
  /** Items the judge did not return a score for. */
  unscored: number;
}

interface Pending {
  kind: "question" | "flashcard";
  ref: string;
  canary: boolean;
  target?: string;
  text: string;
  block: string;
}

const BATCH = 10;

/**
 * Deliberately bad items, mixed in with the real ones under ids that give nothing away. A judge
 * that scores these well is not reading, and its opinion of the real items is worth nothing.
 *
 * Each is bad in one way and is checked on that dimension alone. A flashcard with a wrong answer
 * is still perfectly clear, and a judge that says so is right: averaging its scores would blame the
 * judge for the check's own mistake (which is what the first live run of this did).
 */
function canaries(kit: Kit): Pending[] {
  const requirement = kit.role.requirements[0];
  if (!requirement) return [];
  const linked = `Linked requirement(s): ${requirement.text}`;
  return [
    {
      kind: "question", ref: "canary-irrelevant", canary: true, target: "relevance", text: "What is your favourite colour, and why?",
      block: `Category: technical. Stated difficulty: 3.\n${linked}\nQuestion: What is your favourite colour, and why?\nAnswer outline: Name a colour and give a reason.`,
    },
    {
      kind: "question", ref: "canary-generic", canary: true, target: "specificity", text: `Tell me about ${requirement.text}.`,
      block: `Category: technical. Stated difficulty: 1.\n${linked}\nQuestion: Tell me about ${requirement.text}.\nAnswer outline: Talk about it.`,
    },
    {
      kind: "flashcard", ref: "canary-wrong", canary: true, target: "correctness", text: "What does HTTP status 404 mean?",
      block: "Front: What does HTTP status 404 mean?\nBack: The server is overloaded and the client should retry later.",
    },
  ];
}

function itemsOf(kit: Kit): Pending[] {
  const requirementText = new Map(kit.role.requirements.map((requirement) => [requirement.id, requirement.text]));
  const linked = (ids: string[]) => ids.map((id) => requirementText.get(id)).filter(Boolean).join("; ") || "none (a company-fit question may stand without one)";
  return [
    ...kit.questions.map((question): Pending => ({
      kind: "question", ref: question.id, canary: false, text: question.prompt,
      block: `Category: ${question.category}. Stated difficulty: ${question.difficulty}.\nLinked requirement(s): ${linked(question.requirement_ids)}\nQuestion: ${question.prompt}\nAnswer outline: ${question.answer_outline}`,
    })),
    ...kit.flashcards.map((card): Pending => ({ kind: "flashcard", ref: card.id, canary: false, text: card.front, block: `Front: ${card.front}\nBack: ${card.back}` })),
  ];
}

/** Deterministic, so a report can be reproduced, and so the canaries do not always sit last. */
function shuffled<T>(items: T[], seed: string): T[] {
  let state = [...seed].reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) | 0, 7) || 1;
  const next = () => ((state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export async function judgeKit(id: string, kit: Kit, llm: LlmClient, options: { withCanaries?: boolean } = {}): Promise<KitJudgement> {
  const pending = shuffled([...itemsOf(kit), ...(options.withCanaries === false ? [] : canaries(kit))], id);
  const context = `Role: ${kit.role.title || "not stated"}${kit.role.seniority ? ` (${kit.role.seniority})` : ""}`;
  const judged: JudgedItem[] = [];
  let unscored = 0;

  for (const kind of ["question", "flashcard"] as const) {
    const ofKind = pending.filter((item) => item.kind === kind);
    for (let start = 0; start < ofKind.length; start += BATCH) {
      const batch = ofKind.slice(start, start + BATCH);
      // Opaque ids: the judge must not be able to tell a planted item from its label.
      const labelled = batch.map((item, index) => ({ item, id: `${kind === "question" ? "Q" : "F"}${start + index + 1}` }));
      const prompt = `${context}\n\nScore every item below. Return exactly one entry per item id.\n\n${wrapUntrusted("items", labelled.map(({ item, id: label }) => `[${label}]\n${item.block}`).join("\n\n"), 16_000)}`;

      const answer = await llm.generate<{ items: Array<{ id: string; reason: string } & Record<string, unknown>> }>({
        step: `judge:${kind}s`,
        system: kind === "question" ? QUESTION_RUBRIC : FLASHCARD_RUBRIC,
        prompt,
        schema: (kind === "question" ? QuestionScores : FlashcardScores) as z.ZodType<{ items: Array<{ id: string; reason: string } & Record<string, unknown>> }>,
        maxOutputTokens: 2_000,
      });

      for (const { item, id: label } of labelled) {
        const entry = answer.items.find((candidate) => candidate.id === label);
        if (!entry) {
          unscored++;
          continue;
        }
        const dimensions: readonly string[] = kind === "question" ? QUESTION_DIMENSIONS : FLASHCARD_DIMENSIONS;
        const scores = Object.fromEntries(dimensions.map((dimension) => [dimension, entry[dimension] as number]));
        judged.push({ kind, ref: item.ref, canary: item.canary, ...(item.target ? { target: item.target } : {}), text: item.text, reason: entry.reason, scores, mean: mean(Object.values(scores)) });
      }
    }
  }
  return { id, items: judged, unscored };
}

export interface JudgeReport {
  judge: string;
  kits: Array<{ id: string; questions: number; flashcards: number; questionMean: number | null; flashcardMean: number | null; byDimension: Record<string, number> }>;
  overall: { questionMean: number | null; flashcardMean: number | null; mean: number | null; byDimension: Record<string, number>; items: number; unscored: number };
  /** Whether the judge told planted bad items from real ones. If not, nothing above should be believed. */
  judgeCheck: {
    reliable: boolean;
    /** Mean score of the planted items on the dimension each was built to fail. */
    canaryMean: number | null;
    /** Mean score of the real items on those same dimensions. */
    realMean: number | null;
    canaries: Array<{ kit: string; ref: string; dimension: string; score: number; reason: string }>;
    verdict: string;
  };
  weakest: Array<{ kit: string; ref: string; kind: string; mean: number; text: string; reason: string }>;
}

/** A planted item must score at or below this on the dimension it was built to fail, and the real items clearly above that. */
export const CANARY_CEILING = 2;
export const CANARY_GAP = 1;

export function summarise(judgements: KitJudgement[], judge: string): JudgeReport {
  const real = judgements.flatMap((kit) => kit.items.filter((item) => !item.canary).map((item) => ({ kit: kit.id, ...item })));
  const planted = judgements.flatMap((kit) => kit.items.filter((item) => item.canary).map((item) => ({ kit: kit.id, ...item })));
  const byDimension = (items: JudgedItem[]) => {
    const names = [...new Set(items.flatMap((item) => Object.keys(item.scores)))];
    return Object.fromEntries(names.map((name) => [name, round(mean(items.filter((item) => name in item.scores).map((item) => item.scores[name]!)))]));
  };
  const meanOf = (items: JudgedItem[]) => (items.length > 0 ? round(mean(items.map((item) => item.mean))) : null);

  const checked = planted.flatMap((item) => (item.target && item.target in item.scores ? [{ ...item, dimension: item.target, score: item.scores[item.target]! }] : []));
  const targeted = [...new Set(checked.map((item) => item.dimension))];
  const canaryMean = checked.length > 0 ? round(mean(checked.map((item) => item.score))) : null;
  const realOnTargets = real.flatMap((item) => targeted.filter((dimension) => dimension in item.scores).map((dimension) => item.scores[dimension]!));
  const realMean = realOnTargets.length > 0 ? round(mean(realOnTargets)) : null;
  const worstCanary = checked.length > 0 ? Math.max(...checked.map((item) => item.score)) : null;
  const reliable = worstCanary !== null && worstCanary <= CANARY_CEILING && realMean !== null && canaryMean !== null && realMean - canaryMean >= CANARY_GAP;

  return {
    judge,
    kits: judgements.map((kit) => {
      const own = kit.items.filter((item) => !item.canary);
      return {
        id: kit.id,
        questions: own.filter((item) => item.kind === "question").length,
        flashcards: own.filter((item) => item.kind === "flashcard").length,
        questionMean: meanOf(own.filter((item) => item.kind === "question")),
        flashcardMean: meanOf(own.filter((item) => item.kind === "flashcard")),
        byDimension: byDimension(own),
      };
    }),
    overall: {
      questionMean: meanOf(real.filter((item) => item.kind === "question")),
      flashcardMean: meanOf(real.filter((item) => item.kind === "flashcard")),
      mean: meanOf(real),
      byDimension: byDimension(real),
      items: real.length,
      unscored: judgements.reduce((sum, kit) => sum + kit.unscored, 0),
    },
    judgeCheck: {
      reliable,
      canaryMean,
      realMean,
      canaries: checked.map((item) => ({ kit: item.kit, ref: item.ref, dimension: item.dimension, score: item.score, reason: item.reason })),
      verdict:
        checked.length === 0
          ? "No planted items were scored, so the judge was not checked."
          : reliable
            ? `The judge scored every planted bad item at ${CANARY_CEILING} or below on the dimension it was built to fail, and real items ${round(realMean! - canaryMean!)} higher on those dimensions.`
            : `The judge did not reliably tell planted bad items from real ones (worst planted item scored ${worstCanary} where it should fail). Do not rely on these scores.`,
    },
    weakest: [...real].sort((a, b) => a.mean - b.mean).slice(0, 8).map((item) => ({ kit: item.kit, ref: item.ref, kind: item.kind, mean: round(item.mean), text: item.text, reason: item.reason })),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A model marking its own homework is kinder than it should be, so the judge is the other provider whenever there is a key for it. */
export function judgeConfigFor(config: Config, generatedBy: string[]): { config: Config; note: string } {
  const generator = generatedBy[0]?.split(":")[0];
  const other = generator === "groq" ? "gemini" : "groq";
  const otherKey = other === "groq" ? config.GROQ_API_KEY : config.GEMINI_API_KEY;
  if ((generator === "gemini" || generator === "groq") && otherKey) {
    return { config: { ...config, LLM_PROVIDER: other }, note: `Kits were generated by ${generator}; judging with ${other}.` };
  }
  return { config, note: `Judging with ${config.LLM_PROVIDER}${generator === config.LLM_PROVIDER ? ", the same provider that generated the kits (no key for another): expect it to be lenient" : ""}.` };
}
