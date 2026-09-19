import { z } from "zod";
import type { Question, QuestionCategory, Requirement } from "../kit/schema";
import type { LlmClient } from "../llm/types";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../llm/untrusted";

const ProposedQuestionsSchema = z.object({
  questions: z.array(
    z.object({
      requirement_ids: z.array(z.string()),
      prompt: z.string().min(1),
      answer_outline: z.string().min(1),
      difficulty: z.number().int().min(1).max(3),
    }),
  ),
});

export type DraftQuestion = Omit<Question, "id">;

export interface QuestionContext {
  roleTitle: string;
  seniority: string;
}

/** Each category is a different interview, so each gets its own instructions and its own call. */
const CATEGORY_BRIEF: Record<QuestionCategory, string> = {
  technical:
    "You write technical interview questions. Each question tests whether the candidate can actually do what a requirement names: " +
    "how something works, how they would debug it, what trade-off they would make. Prefer concrete scenarios over definitions.",
  behavioural:
    "You write behavioural interview questions. Each asks for a specific past situation (\"Tell me about a time...\") that would show the trait a requirement names. " +
    "The answer outline follows situation, action, result, and says what a strong answer demonstrates.",
  "system-design":
    "You write system design interview questions. Each gives an open-ended system to design that exercises the listed requirements, scaled to the role's seniority. " +
    "The answer outline lists the components, the key trade-offs and the follow-up probes an interviewer would use.",
  "company-fit":
    "You write company-fit interview questions: motivation for this company and role, and how the candidate's way of working matches what the company says about itself.",
};

const SHARED_RULES = `Rules:
- Use only the requirement ids you are given. Every question lists the ids of the requirements it covers.
- Every listed requirement must be covered by at least one question.
- "difficulty" is 1 (warm-up), 2 (standard) or 3 (hard).
- "answer_outline" is a short outline of a strong answer, not a full essay.
- Do not invent facts about the company or the role.
- ${UNTRUSTED_CONTENT_RULE}`;

export interface GenerateQuestionsInput {
  category: QuestionCategory;
  requirements: Requirement[];
  context: QuestionContext;
  /** Extra, category-specific direction, e.g. the hiring stages the company publishes. */
  guidance?: string;
  /** Gap-closing pass: the model is told these requirements were missed the first time. */
  closingGaps?: boolean;
}

/**
 * One call for one category over the requirements that belong to it. The model
 * writes the questions; code discards any requirement id it made up and any
 * question left covering nothing.
 */
export async function generateQuestions(input: GenerateQuestionsInput, llm: LlmClient): Promise<DraftQuestion[]> {
  const { category, requirements, context, guidance, closingGaps = false } = input;
  if (requirements.length === 0) return [];

  const target = closingGaps ? requirements.length : Math.min(12, Math.max(3, Math.ceil(requirements.length * 1.5)));
  const requirementList = requirements.map((r) => `${r.id} [${r.priority}] ${r.text}`).join("\n");

  const prompt = [
    `Role: ${context.roleTitle || "not stated"}${context.seniority ? ` (${context.seniority})` : ""}`,
    closingGaps
      ? `These requirements have no question yet. Write exactly one question for each of them (${target} in total).`
      : `Write about ${target} questions covering these requirements. Spend more questions on [must] requirements.`,
    guidance ?? "",
    wrapUntrusted("requirements", requirementList),
  ]
    .filter(Boolean)
    .join("\n\n");

  const proposed = await llm.generate({
    step: closingGaps ? `close-gaps:${category}` : `questions:${category}`,
    system: `${CATEGORY_BRIEF[category]}\n\n${SHARED_RULES}`,
    prompt,
    schema: ProposedQuestionsSchema,
  });

  const known = new Set(requirements.map((r) => r.id));
  return proposed.questions
    .map((question) => ({
      requirement_ids: [...new Set(question.requirement_ids.filter((id) => known.has(id)))],
      category,
      prompt: question.prompt.trim(),
      answer_outline: question.answer_outline.trim(),
      difficulty: question.difficulty,
      origin: "generated" as const,
    }))
    .filter((question) => question.requirement_ids.length > 0);
}

/** Technical and domain requirements are tested by technical questions; behavioural ones by behavioural questions. */
export function categoryFor(requirement: Requirement): QuestionCategory {
  return requirement.kind === "behavioural" ? "behavioural" : "technical";
}
