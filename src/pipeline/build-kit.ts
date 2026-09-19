import { closeCoverageGaps } from "../coverage/coverage";
import { EmptyDescriptionError, extractRole } from "../extraction/extract";
import { categoryFor, generateQuestions, type DraftQuestion, type QuestionContext } from "../generation/questions";
import { idAllocator } from "../kit/ids";
import type { Kit, Question, QuestionCategory, Requirement } from "../kit/schema";
import { validateKit } from "../kit/validate";
import { LlmError, type LlmClient } from "../llm/types";
import { allocateSchedule } from "../scheduling/allocate";
import { PipelineError } from "./errors";

export interface PipelineInput {
  jd: string;
  companyUrl: string;
  days: number;
}

export type PipelineStep = "extract" | "questions" | "coverage" | "schedule" | "validate";

export interface ProgressEvent {
  step: PipelineStep;
  status: "started" | "done" | "skipped" | "failed";
  detail?: string;
}

export interface PipelineDeps {
  llm: LlmClient;
  now?: () => Date;
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * The one path from a job description to a kit. The HTTP API and the batch
 * command both call this; there is no second implementation.
 */
export async function buildKit(input: PipelineInput, deps: PipelineDeps): Promise<Kit> {
  const { llm, now = () => new Date(), onProgress = () => undefined } = deps;
  const notes: string[] = [];

  // 1. Extract. Pasted text needs no retrieval.
  onProgress({ step: "extract", status: "started" });
  const role = await extractRole(input.jd, llm).catch((error: unknown) => {
    onProgress({ step: "extract", status: "failed", detail: errorMessage(error) });
    if (error instanceof EmptyDescriptionError) throw new PipelineError("JD_EMPTY", error.message);
    throw toPipelineError(error);
  });
  onProgress({ step: "extract", status: "done", detail: `${role.requirements.length} requirements` });
  if (role.thin) {
    notes.push(
      `The job description states only ${role.requirements.length} requirement(s), so this kit is deliberately thin. Nothing was added that the posting does not say.`,
    );
  }

  // 2. Questions, one call per category that has requirements.
  onProgress({ step: "questions", status: "started" });
  const nextQuestionId = idAllocator("q");
  const questions: Question[] = [];
  const context: QuestionContext = { roleTitle: role.title, seniority: role.seniority };
  for (const category of REQUIREMENT_CATEGORIES) {
    const requirements = role.requirements.filter((r) => categoryFor(r) === category);
    const drafts = await generateQuestions({ category, requirements, context }, llm).catch((error: unknown) =>
      degrade(error, `${category} questions`, notes),
    );
    questions.push(...drafts.map((draft) => ({ id: nextQuestionId(), ...draft })));
  }
  onProgress({ step: "questions", status: "done", detail: `${questions.length} questions` });

  // 3. Second pass. Code finds the requirements no question covers, the model is asked for
  //    those only, and code checks again. Must-haves still open get a question written by code.
  onProgress({ step: "coverage", status: "started" });
  const coverage = await closeCoverageGaps(role.requirements, questions, (gaps) => generateForGaps(gaps, context, llm));
  questions.push(...coverage.added.map((draft) => ({ id: nextQuestionId(), ...draft })));
  const fallbacks = coverage.added.filter((q) => q.origin === "fallback").length;
  if (fallbacks > 0) {
    notes.push(`${fallbacks} must-have requirement(s) got a standard question written by the application because the model did not cover them.`);
  }
  onProgress({
    step: "coverage",
    status: "done",
    detail: `${coverage.passes} pass(es), ${coverage.added.length} question(s) added, ${coverage.uncovered.length} nice-to-have uncovered`,
  });

  // 4. Schedule: arithmetic, never the model.
  onProgress({ step: "schedule", status: "started" });
  const schedule = allocateSchedule({ days: input.days, questions, requirements: role.requirements });
  onProgress({ step: "schedule", status: "done" });

  const kit: Kit = {
    source: {
      company: role.company,
      company_url: input.companyUrl,
      role: role.title,
      location: role.location,
      jd_chars: input.jd.length,
      researched_at: now().toISOString(),
      pages_used: [],
    },
    company_brief: { summary: "", what_they_do: "", sources: [] },
    role: {
      title: role.title,
      seniority: role.seniority,
      responsibilities: role.responsibilities,
      requirements: role.requirements,
    },
    questions,
    flashcards: [],
    schedule,
    coverage: { uncovered_requirement_ids: coverage.uncovered.map((r) => r.id), passes: coverage.passes },
    hiring_stages: [],
    research_log: [],
    notes,
  };

  // 5. Nothing leaves the pipeline without passing the structure check.
  onProgress({ step: "validate", status: "started" });
  const validation = validateKit(kit);
  if (!validation.ok) {
    onProgress({ step: "validate", status: "failed", detail: validation.issues.join("; ") });
    throw new PipelineError("KIT_INVALID", `Generated kit failed validation: ${validation.issues.join("; ")}`);
  }
  onProgress({ step: "validate", status: "done" });
  return validation.kit;
}

/** Categories whose questions are driven by requirements. */
const REQUIREMENT_CATEGORIES = ["technical", "behavioural"] satisfies QuestionCategory[];

/** Gap questions still come from the right kind of call: technical gaps and behavioural gaps are asked separately. */
async function generateForGaps(gaps: Requirement[], context: QuestionContext, llm: LlmClient): Promise<DraftQuestion[]> {
  const drafts: DraftQuestion[] = [];
  for (const category of REQUIREMENT_CATEGORIES) {
    const requirements = gaps.filter((r) => categoryFor(r) === category);
    drafts.push(...(await generateQuestions({ category, requirements, context, closingGaps: true }, llm)));
  }
  return drafts;
}

/** A generation step that fails costs its section, not the kit. A model that is down entirely still fails the case. */
function degrade(error: unknown, what: string, notes: string[]): [] {
  if (error instanceof LlmError && error.code === "LLM_UNAVAILABLE") throw toPipelineError(error);
  notes.push(`Could not generate ${what}: ${errorMessage(error)}`);
  return [];
}

function toPipelineError(error: unknown): PipelineError {
  if (error instanceof PipelineError) return error;
  if (error instanceof LlmError) {
    return new PipelineError(error.code === "LLM_UNAVAILABLE" ? "LLM_UNAVAILABLE" : "KIT_INVALID", error.message);
  }
  return new PipelineError("INTERNAL", errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
