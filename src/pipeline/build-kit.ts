import { closeCoverageGaps } from "../coverage/coverage";
import { EmptyDescriptionError, extractRole } from "../extraction/extract";
import { writeCompanyBrief, type BriefResult } from "../generation/brief";
import { generateFlashcards } from "../generation/flashcards";
import { planQuestionCalls } from "../generation/plan";
import { categoryFor, generateQuestions, type DraftQuestion, type QuestionContext } from "../generation/questions";
import { idAllocator } from "../kit/ids";
import type { Kit, Question, QuestionCategory, Requirement } from "../kit/schema";
import { validateKit } from "../kit/validate";
import { LlmError, type LlmClient } from "../llm/types";
import { crawlCompanySite, type CrawledPage, type SiteCrawl } from "../retrieval/crawl";
import { createDiscussionSearch, type DiscussionResult, type DiscussionSearch } from "../retrieval/discussion";
import type { PageFetcher } from "../retrieval/fetcher";
import { allocateSchedule } from "../scheduling/allocate";
import { createTraceRecorder, tracedFetcher, type RunTrace, type TraceRecorder } from "../trace/trace";
import { PipelineError } from "./errors";
import { PIPELINE_VERSION, promptFingerprint } from "./generator";

export interface PipelineInput {
  jd: string;
  companyUrl: string;
  days: number;
}

export type PipelineStep = "extract" | "crawl" | "discussion" | "brief" | "questions" | "coverage" | "flashcards" | "schedule" | "validate";

export interface ProgressEvent {
  step: PipelineStep;
  status: "started" | "done" | "skipped" | "failed";
  detail?: string;
}

export interface PipelineDeps {
  llm: LlmClient;
  fetcher: PageFetcher;
  /** Defaults to the public sources in retrieval/discussion, reached through `fetcher`. */
  searchDiscussion?: DiscussionSearch;
  now?: () => Date;
  onProgress?: (event: ProgressEvent) => void;
  /** Set when the caller has given up on this kit (a batch case past its time budget). No further model call is started. */
  signal?: AbortSignal;
  /** Given the run's trace when the run ends, whether it produced a kit or not. */
  onTrace?: (trace: RunTrace) => void;
}

/**
 * The one path from a job description to a kit. The HTTP API and the batch
 * command both call this; there is no second implementation.
 *
 * Each step uses what the previous ones actually found. Only extraction can
 * fail the whole kit: after it, a step that fails costs its own section and
 * leaves a note, and coverage is guaranteed by code either way.
 *
 * The model client and the fetcher are shared between runs, so what this run
 * did with them is recorded here, by wrapping both for the length of the run.
 */
export async function buildKit(input: PipelineInput, deps: PipelineDeps): Promise<Kit> {
  const trace = createTraceRecorder();
  const traced: PipelineDeps = {
    ...deps,
    fetcher: tracedFetcher(deps.fetcher, trace),
    llm: {
      generate: (request) => {
        // An abandoned kit must not keep queueing calls on the shared rate limiter ahead of the kits still wanted.
        deps.signal?.throwIfAborted();
        return deps.llm.generate({
          ...request,
          onCall: (record) => {
            trace.llmCall(record);
            request.onCall?.(record);
          },
        });
      },
    },
    onProgress: (event) => {
      trace.step(event);
      deps.onProgress?.(event);
    },
  };

  try {
    const kit = await runPipeline(input, traced, trace);
    deps.onTrace?.(trace.finish("ok"));
    return kit;
  } catch (error) {
    deps.onTrace?.(trace.finish("failed", errorMessage(error)));
    throw error;
  }
}

async function runPipeline(input: PipelineInput, deps: PipelineDeps, trace: TraceRecorder): Promise<Kit> {
  const { fetcher, llm, now = () => new Date(), onProgress = () => undefined } = deps;
  const searchDiscussion = deps.searchDiscussion ?? createDiscussionSearch(fetcher);
  const notes: string[] = [];

  // 1. Extract. Pasted text needs no retrieval.
  onProgress({ step: "extract", status: "started" });
  const role = await extractRole(input.jd, llm).catch((error: unknown) => {
    onProgress({ step: "extract", status: "failed", detail: errorMessage(error) });
    if (error instanceof EmptyDescriptionError) throw new PipelineError("JD_EMPTY", error.message);
    throw toPipelineError(error);
  });
  onProgress({ step: "extract", status: "done", detail: `${role.requirements.length} requirement(s)` });
  if (role.thin) {
    notes.push(
      `The job description states only ${role.requirements.length} requirement(s), so this kit is deliberately thin. Nothing was added that the posting does not say.`,
    );
  }

  // 2. Crawl the company site. A homepage is only useful once its links have been ranked and followed.
  onProgress({ step: "crawl", status: "started" });
  // Whatever goes wrong while reading someone else's site costs the research, never the kit.
  const crawl = await crawlCompanySite(withScheme(input.companyUrl), fetcher).catch(
    (error: unknown): SiteCrawl => ({
      reachable: false,
      failure: "The site could not be read.",
      siteName: "",
      pages: [],
      log: [{ source: "company-site", url: input.companyUrl, outcome: "failed", reason: `Unexpected error while reading the site: ${errorMessage(error)}` }],
    }),
  );
  if (!crawl.reachable) {
    notes.push(`The company site could not be read (${crawl.failure}) so this kit is based on the job description alone.`);
  } else if (!crawl.hiring) {
    notes.push("The company site does not publish how it hires, so the questions are not tailored to a known interview format.");
  }
  onProgress({
    step: "crawl",
    status: crawl.reachable ? "done" : "failed",
    detail: crawl.reachable ? `${crawl.pages.length} page(s) read, hiring page ${crawl.hiring ? "found" : "not found"}` : crawl.failure,
  });

  // 3. Public discussion of how this company interviews. Needs a company name, which may only be known after the crawl.
  const company = role.company || crawl.siteName;
  onProgress({ step: "discussion", status: "started" });
  const discussion = await searchDiscussion(company).catch(
    (error: unknown): DiscussionResult => ({ snippets: [], log: [{ source: "public-discussion", outcome: "skipped", reason: `Search failed: ${errorMessage(error)}` }] }),
  );
  onProgress({
    step: "discussion",
    status: discussion.snippets.length > 0 ? "done" : "skipped",
    detail: discussion.snippets.length > 0 ? `${discussion.snippets.length} relevant result(s)` : "nothing relevant found",
  });

  // 4. Brief and hiring stages, from what was retrieved and nothing else.
  onProgress({ step: "brief", status: "started" });
  const briefInput = { company, home: crawl.home, about: crawl.about, hiring: crawl.hiring, discussion: discussion.snippets, siteFailure: crawl.failure };
  const researched = await writeCompanyBrief(briefInput, llm).catch((error: unknown): BriefResult => {
    notes.push(`The company brief could not be written: ${errorMessage(error)}`);
    return {
      brief: { summary: "The company brief could not be generated. Regenerate this section to try again.", what_they_do: "", sources: [], origin: "generated" },
      hiringStages: [],
      interviewInsights: [],
    };
  });
  const companyKnown = researched.brief.sources.length > 0;
  const discussionLog = [...discussion.log];
  if (discussion.snippets.length > 0 && researched.interviewInsights.length === 0) {
    discussionLog.push({
      source: "public-discussion",
      outcome: "empty",
      reason: `${discussion.snippets.length} search result(s) mentioned the company name, but none was clearly about interviewing at this company, so none was used.`,
    });
  }
  onProgress({ step: "brief", status: "done", detail: `${researched.hiringStages.length} hiring stage(s) published` });

  // 5. Questions. Which calls are made, and with what instructions, depends on steps 1-4.
  onProgress({ step: "questions", status: "started" });
  const context: QuestionContext = { roleTitle: role.title, seniority: role.seniority };
  const nextQuestionId = idAllocator("q");
  const questions: Question[] = [];
  const plan = planQuestionCalls({
    title: role.title,
    seniority: role.seniority,
    requirements: role.requirements,
    hiringStages: researched.hiringStages,
    interviewInsights: researched.interviewInsights,
    brief: companyKnown ? researched.brief : undefined,
  });
  for (const call of plan) {
    const drafts = await generateQuestions({ ...call, context }, llm).catch((error: unknown) => {
      notes.push(`Could not generate ${call.category} questions: ${errorMessage(error)}`);
      return [] as DraftQuestion[];
    });
    questions.push(...drafts.map((draft) => ({ id: nextQuestionId(), ...draft })));
  }
  onProgress({ step: "questions", status: "done", detail: `${questions.length} question(s) from ${plan.map((call) => call.category).join(", ") || "no calls"}` });

  // 6. Second pass. Code finds the requirements no question covers, the model is asked for
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

  // 7. Flashcards.
  onProgress({ step: "flashcards", status: "started" });
  const nextFlashcardId = idAllocator("f");
  const companyFacts = companyKnown
    ? [`What they do: ${researched.brief.what_they_do}`, ...researched.hiringStages.map((stage, index) => `Hiring stage ${index + 1}: ${stage}`)]
    : [];
  const flashcards = (
    await generateFlashcards({ roleTitle: role.title, requirements: role.requirements, companyFacts }, llm).catch((error: unknown) => {
      notes.push(`Flashcards could not be generated: ${errorMessage(error)}`);
      return [];
    })
  ).map((draft) => ({ id: nextFlashcardId(), ...draft }));
  onProgress({ step: "flashcards", status: "done", detail: `${flashcards.length} card(s)` });

  // 8. Schedule: arithmetic, never the model.
  onProgress({ step: "schedule", status: "started" });
  const schedule = allocateSchedule({ days: input.days, questions, requirements: role.requirements });
  onProgress({ step: "schedule", status: "done" });

  const researchPages = [crawl.home, crawl.about, crawl.hiring].filter((page): page is CrawledPage => Boolean(page?.text));
  const kit: Kit = {
    source: {
      company,
      company_url: input.companyUrl,
      role: role.title,
      location: role.location,
      jd_chars: input.jd.length,
      researched_at: now().toISOString(),
      pages_used: researchPages.map((page) => page.url),
    },
    company_brief: researched.brief,
    role: {
      title: role.title,
      seniority: role.seniority,
      responsibilities: role.responsibilities,
      requirements: role.requirements,
    },
    questions,
    flashcards,
    schedule,
    coverage: { uncovered_requirement_ids: coverage.uncovered.map((r) => r.id), passes: coverage.passes },
    hiring_stages: researched.hiringStages,
    interview_insights: researched.interviewInsights,
    research_log: [...crawl.log, ...discussionLog],
    notes,
    generator: { pipeline: PIPELINE_VERSION, prompts: promptFingerprint(), models: trace.models() },
  };

  // 9. Nothing leaves the pipeline without passing the structure check.
  onProgress({ step: "validate", status: "started" });
  const validation = validateKit(kit);
  if (!validation.ok) {
    onProgress({ step: "validate", status: "failed", detail: validation.issues.join("; ") });
    throw new PipelineError("KIT_INVALID", `Generated kit failed validation: ${validation.issues.join("; ")}`);
  }
  onProgress({ step: "validate", status: "done" });
  return validation.kit;
}

/** Categories whose questions exist to cover requirements. */
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

/** "acme.com" and "localhost:8099/acme/" are what people type. The kit still records the address as it was given. */
function withScheme(url: string): string {
  const trimmed = url.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
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
