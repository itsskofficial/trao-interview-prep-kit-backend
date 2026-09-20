import { z } from "zod";

/**
 * The kit structure from Appendix A of the brief. Field names there are exact;
 * everything marked "extension" is additive and optional, so a bare Appendix A
 * kit still validates.
 */

export const RequirementKindSchema = z.enum(["technical", "behavioural", "domain"]);
export const PrioritySchema = z.enum(["must", "nice"]);
export const QuestionCategorySchema = z.enum([
  "technical",
  "behavioural",
  "system-design",
  "company-fit",
]);

/** Extension: where an item came from. "fallback" is a question built by code, not the model. */
export const OriginSchema = z.enum(["generated", "user", "fallback"]);

/** Extension: builder state. Regeneration only replaces generated, unedited, unpinned items. */
const provenance = {
  origin: OriginSchema.optional(),
  edited: z.boolean().optional(),
  pinned: z.boolean().optional(),
};

const id = z.string().min(1);

export const RequirementSchema = z.object({
  id,
  text: z.string().min(1),
  kind: RequirementKindSchema,
  priority: PrioritySchema,
  /** Extension: the verbatim line of the job description this requirement was taken from. */
  evidence: z.string().optional(),
});

export const QuestionSchema = z.object({
  id,
  requirement_ids: z.array(id),
  category: QuestionCategorySchema,
  prompt: z.string().min(1),
  answer_outline: z.string(),
  difficulty: z.number().int().min(1).max(3),
  ...provenance,
});

export const FlashcardSchema = z.object({
  id,
  front: z.string().min(1),
  back: z.string(),
  requirement_ids: z.array(id),
  ...provenance,
});

export const ScheduleDaySchema = z.object({
  day: z.number().int().min(1),
  focus: z.string().min(1),
  question_ids: z.array(id),
  minutes: z.number().int().min(0),
});

/** Extension: one entry per source the research steps tried, whether or not it worked. */
export const ResearchLogEntrySchema = z.object({
  source: z.string(),
  url: z.string().optional(),
  outcome: z.enum(["used", "empty", "skipped", "failed"]),
  reason: z.string().optional(),
});

/** The words a claim about the company rests on, copied from where they were found. */
export const ResearchEvidenceSchema = z.object({
  claim: z.string().min(1),
  quote: z.string().min(1),
  source: z.enum(["hiring-page", "public-discussion"]),
  url: z.string().optional(),
});

export const KitSchema = z.object({
  source: z.object({
    company: z.string(),
    company_url: z.string(),
    role: z.string(),
    location: z.string(),
    jd_chars: z.number().int().min(0),
    researched_at: z.string().min(1),
    pages_used: z.array(z.string()),
  }),
  company_brief: z.object({
    summary: z.string(),
    what_they_do: z.string(),
    sources: z.array(z.string()),
    ...provenance,
  }),
  role: z.object({
    title: z.string(),
    seniority: z.string(),
    responsibilities: z.array(z.string()),
    requirements: z.array(RequirementSchema),
  }),
  questions: z.array(QuestionSchema),
  flashcards: z.array(FlashcardSchema),
  schedule: z.object({
    days_available: z.number().int().min(1),
    days: z.array(ScheduleDaySchema),
    /** Extension: set when the user re-planned the remaining days around their weak spots. */
    replan: z.object({ from_day: z.number().int().min(1), focus_question_ids: z.array(id) }).optional(),
  }),
  coverage: z.object({
    uncovered_requirement_ids: z.array(id),
    passes: z.number().int().min(0),
  }),
  /** Extension: hiring stages found on the company site, in order. Empty when none were published. */
  hiring_stages: z.array(z.string()).optional(),
  /** Extension: what public discussion says about interviewing at this company. Empty when none was found. */
  interview_insights: z.array(z.string()).optional(),
  /** Extension: every source attempted during research. */
  research_log: z.array(ResearchLogEntrySchema).optional(),
  /** Extension: for each hiring stage and interview insight, the sentence it was taken from. */
  research_evidence: z.array(ResearchEvidenceSchema).optional(),
  /** Extension: plain-language honesty notes, e.g. a thin description or an unreachable site. */
  notes: z.array(z.string()).optional(),
  /** Extension: what produced this kit, so output can be compared across prompt and model changes. */
  generator: z
    .object({
      pipeline: z.string(),
      /** Changes whenever any system prompt changes. */
      prompts: z.string(),
      /** The models that actually answered, most used first. Empty when no model call succeeded. */
      models: z.array(z.string()),
    })
    .optional(),
});

export type RequirementKind = z.infer<typeof RequirementKindSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type QuestionCategory = z.infer<typeof QuestionCategorySchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Flashcard = z.infer<typeof FlashcardSchema>;
export type ScheduleDay = z.infer<typeof ScheduleDaySchema>;
export type ResearchLogEntry = z.infer<typeof ResearchLogEntrySchema>;
export type ResearchEvidence = z.infer<typeof ResearchEvidenceSchema>;
export type Kit = z.infer<typeof KitSchema>;
