import type { ObjectId } from "mongodb";
import { writeCompanyBrief } from "../generation/brief";
import { planQuestionCalls, type PlannedCall } from "../generation/plan";
import { categoryFor, generateQuestions } from "../generation/questions";
import type { Kit, QuestionCategory } from "../kit/schema";
import { wrapUntrusted } from "../llm/untrusted";
import type { KitRepository, StoredKit } from "../persistence/kits";
import type { KitDoc, RegenerationTarget } from "../persistence/mongo";
import type { PipelineDeps } from "../pipeline/build-kit";
import { crawlCompanySite } from "../retrieval/crawl";
import { createDiscussionSearch } from "../retrieval/discussion";
import { createLinkPicker } from "../retrieval/pick-links";
import { lexicalEmbedder } from "../similarity/embedder";
import { withoutDuplicates } from "../similarity/questions";
import { isProtected, reconcile } from "./operations";
import { mergeRegeneratedQuestions, undoRegeneratedQuestions } from "./regenerate-merge";

export class RegenerationRefused extends Error {
  constructor(
    readonly code: "ALREADY_REGENERATING" | "BRIEF_PROTECTED" | "NOTHING_TO_UNDO",
    message: string,
  ) {
    super(message);
    this.name = "RegenerationRefused";
  }
}

export type RegenerationRequest = { section: "schedule" } | (RegenerationTarget & { force?: boolean });

export interface Regenerator {
  /** Returns as soon as the kit is marked as regenerating; the work carries on in the background. */
  start(userId: ObjectId, kitId: string, request: RegenerationRequest): Promise<StoredKit | undefined>;
  undo(userId: ObjectId, kitId: string): Promise<StoredKit | undefined>;
  /** Resolves when no regeneration is in flight. For tests and graceful shutdown. */
  idle(): Promise<void>;
}

/**
 * Regenerates one section of a kit. The model call happens away from the kit;
 * its result is then merged into the kit as it stands at that moment, through
 * the repository's versioned save. Edits made while the model was thinking are
 * therefore already in the kit the merge sees, and already protected.
 */
export function createRegenerator(kits: KitRepository, pipeline: PipelineDeps): Regenerator {
  const inFlight = new Set<Promise<void>>();
  const embedder = pipeline.embedder ?? lexicalEmbedder();

  async function regenerateQuestions(userId: ObjectId, kitId: string, category: QuestionCategory, kit: Kit): Promise<void> {
    const call = plannedCallFor(kit, category);
    const keeping = kit.questions.filter((question) => question.category === category && isProtected(question));
    const guidance = [
      call.guidance,
      keeping.length > 0
        ? `The candidate is keeping these questions. Write different ones.\n${wrapUntrusted("existing_questions", keeping.map((q) => `- ${q.prompt}`).join("\n"), 4_000)}`
        : "",
    ].filter(Boolean).join("\n\n");

    const proposed = await generateQuestions(
      { category, requirements: call.requirements, guidance: guidance || undefined, context: { roleTitle: kit.role.title, seniority: kit.role.seniority } },
      pipeline.llm,
    );
    if (proposed.length === 0) throw new Error("The model returned no usable questions, so the existing ones were kept.");

    // Told which questions are being kept, the model still sometimes writes one of them again in other words.
    const { fresh: drafts } = await withoutDuplicates(keeping.map((question) => question.prompt), proposed, embedder).catch(() => ({ fresh: proposed }));
    if (drafts.length === 0) throw new Error("The model only repeated questions you are keeping, so nothing was replaced.");

    await kits.mutate(userId, kitId, (doc) => {
      const merged = mergeRegeneratedQuestions({ kit: doc.kit, counters: doc.counters }, category, drafts);
      return {
        state: merged.state,
        set: { undo: { section: "questions", category, removed: merged.removed, addedIds: merged.addedIds, at: new Date() } },
        unset: ["regeneration"],
      };
    });
  }

  async function regenerateBrief(userId: ObjectId, kitId: string, kit: Kit, force: boolean): Promise<void> {
    // What the brief said when the user asked. "Replace my edited brief" is consent to replace this text, not whatever they type next.
    const asked = briefText(kit);
    const crawl = await crawlCompanySite(kit.source.company_url, pipeline.fetcher, { pickLinks: createLinkPicker(pipeline.llm), company: kit.source.company });
    const company = kit.source.company || crawl.siteName;
    const discussion = await (pipeline.searchDiscussion ?? createDiscussionSearch(pipeline.fetcher, pipeline.discussion))(company);
    const researched = await writeCompanyBrief(
      { company, home: crawl.home, about: crawl.about, hiring: crawl.hiring, discussion: discussion.snippets, siteFailure: crawl.failure },
      pipeline.llm,
      embedder,
    );

    await kits.mutate(userId, kitId, (doc) => {
      // The user may have started typing in the brief after asking for a new one. Their text wins, forced or not.
      const typedSince = briefText(doc.kit) !== asked;
      if (typedSince || (isProtected(doc.kit.company_brief) && !force)) {
        return { set: { regeneration: { section: "brief", status: "failed", startedAt: new Date(), error: "You edited the brief while it was being regenerated, so your version was kept." } } };
      }
      // Absent optional fields are stored as empty lists: MongoDB would turn `undefined` into `null`, which is not a valid kit.
      const previous = { company_brief: doc.kit.company_brief, hiring_stages: doc.kit.hiring_stages ?? [], interview_insights: doc.kit.interview_insights ?? [], research_evidence: doc.kit.research_evidence ?? [] };
      const next: Kit = {
        ...doc.kit,
        company_brief: researched.brief,
        hiring_stages: researched.hiringStages,
        interview_insights: researched.interviewInsights,
        research_evidence: researched.evidence,
        source: { ...doc.kit.source, pages_used: [crawl.home, crawl.about, crawl.hiring].flatMap((page) => (page?.text ? [page.url] : [])), researched_at: (pipeline.now?.() ?? new Date()).toISOString() },
        research_log: [...crawl.log, ...discussion.log],
      };
      return { state: { kit: next, counters: doc.counters }, set: { undo: { section: "brief", previous, at: new Date() } }, unset: ["regeneration"] };
    });
  }

  function runInBackground(userId: ObjectId, kitId: string, target: RegenerationTarget, work: () => Promise<void>): void {
    const task = work()
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : "Regeneration failed.";
        await kits.mutate(userId, kitId, () => ({ set: { regeneration: { ...target, status: "failed", startedAt: new Date(), error: message } } })).catch(() => undefined);
      })
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  }

  return {
    async start(userId, kitId, request) {
      // The schedule is arithmetic: it is recomputed on the spot, with no model and nothing to wait for.
      if (request.section === "schedule") {
        // Regenerating the schedule also drops any weak-spots re-plan: it is the way back to the default plan.
        return kits.mutate(userId, kitId, (doc) => {
          const { replan: _dropped, ...schedule } = doc.kit.schedule;
          return { state: { kit: reconcile({ ...doc.kit, schedule }), counters: doc.counters } };
        });
      }

      const { force = false, ...target } = request;
      const marked = await kits.mutate(userId, kitId, (doc) => {
        if (doc.regeneration?.status === "running") {
          throw new RegenerationRefused("ALREADY_REGENERATING", "A section of this kit is already being regenerated. Wait for it to finish.");
        }
        if (target.section === "brief" && isProtected(doc.kit.company_brief) && !force) {
          throw new RegenerationRefused("BRIEF_PROTECTED", "You have edited or pinned this brief. Regenerating will replace your text; confirm to continue.");
        }
        return { set: { regeneration: { ...target, status: "running", startedAt: new Date() } } };
      });
      if (!marked) return undefined;

      runInBackground(userId, kitId, target, () =>
        target.section === "brief" ? regenerateBrief(userId, kitId, marked.kit, force) : regenerateQuestions(userId, kitId, target.category, marked.kit),
      );
      return marked;
    },

    async undo(userId, kitId) {
      return kits.mutate(userId, kitId, (doc: KitDoc) => {
        const snapshot = doc.undo;
        if (!snapshot) throw new RegenerationRefused("NOTHING_TO_UNDO", "There is no regeneration to undo.");
        const state = { kit: doc.kit, counters: doc.counters };
        if (snapshot.section === "questions") {
          return { state: undoRegeneratedQuestions(state, snapshot.category, snapshot.removed, snapshot.addedIds), unset: ["undo"] };
        }
        return { state: { ...state, kit: { ...doc.kit, ...snapshot.previous } }, unset: ["undo"] };
      });
    },

    async idle() {
      while (inFlight.size > 0) await Promise.all(inFlight);
    },
  };
}

const briefText = (kit: Kit) => JSON.stringify([kit.company_brief.summary, kit.company_brief.what_they_do]);

/** The same call the first generation would make for this category, from what the kit already knows. No re-crawl. */
function plannedCallFor(kit: Kit, category: QuestionCategory): PlannedCall {
  const companyKnown = kit.company_brief.sources.length > 0;
  const planned = planQuestionCalls({
    title: kit.role.title,
    seniority: kit.role.seniority,
    requirements: kit.role.requirements,
    hiringStages: kit.hiring_stages ?? [],
    interviewInsights: kit.interview_insights ?? [],
    brief: companyKnown ? kit.company_brief : undefined,
  }).find((call) => call.category === category);
  if (planned) return planned;

  // The first run made no call for this category, but the user is asking for one now.
  if (category === "company-fit") throw new Error("Nothing is known about this company, so company-fit questions cannot be generated honestly.");
  const wanted = category === "behavioural" ? "behavioural" : "technical";
  const requirements = kit.role.requirements.filter((requirement) => categoryFor(requirement) === wanted);
  if (requirements.length === 0) throw new Error(`The job description states no ${wanted} requirements to base ${category} questions on.`);
  return { category, requirements, reason: "requested by the user" };
}
