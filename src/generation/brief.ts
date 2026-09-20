import { z } from "zod";
import type { Kit, ResearchEvidence } from "../kit/schema";
import type { LlmClient } from "../llm/types";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../llm/untrusted";
import { PROCESS_TERMS, STAGE_TERMS, type CrawledPage } from "../retrieval/crawl";
import { isQuotedFrom } from "../extraction/evidence";
import { processDigest } from "../retrieval/excerpt";
import type { DiscussionSnippet } from "../retrieval/discussion";
import { lexicalEmbedder, type Embedder } from "../similarity/embedder";
import { checkSupport, type SupportResult } from "../similarity/support";

const ProposedBriefSchema = z.object({
  summary: z.string(),
  what_they_do: z.string(),
  hiring_stages: z.array(z.object({ stage: z.string(), evidence: z.string() })),
  interview_insights: z.array(z.object({ insight: z.string(), evidence: z.string() })),
});

export interface BriefInput {
  company: string;
  home?: CrawledPage;
  about?: CrawledPage;
  hiring?: CrawledPage;
  discussion: DiscussionSnippet[];
  /** Why the site could not be read, when it could not. */
  siteFailure?: string;
}

export interface BriefResult {
  brief: Kit["company_brief"];
  /** In order, as the company publishes them. Empty when it publishes none. */
  hiringStages: string[];
  /** What public discussion says about interviewing there. Empty when there is none. */
  interviewInsights: string[];
  /** The words on the page or in the discussion that each kept stage and insight rests on. */
  evidence: ResearchEvidence[];
  /** What was proposed and not kept, and why. For the run trace. */
  rejected: string[];
}

export const SYSTEM = `You write a short, factual company brief for someone preparing for an interview there.

Rules:
- Use only what the supplied pages and discussion say. If they do not say something, leave it out. Never fill gaps from general knowledge.
- "summary": two or three sentences on who the company is.
- "what_they_do": the product or service and who it is for, in plain words.
- "hiring_stages": the stages of the hiring process in order, ONLY if a supplied page describes them. Otherwise an empty list. For each: "stage" is a short phrase naming it, and "evidence" is the sentence or phrase from the hiring page that states it, copied exactly, word for word.
- "interview_insights": what the public discussion says about interviewing at this company, ONLY if it is clearly about this company. Otherwise an empty list. For each: "insight" in your words, and "evidence" copied exactly from the discussion.
- A stage or insight whose evidence is not found in the supplied text, or does not say what you claim, is discarded. Do not paraphrase inside "evidence".
- ${UNTRUSTED_CONTENT_RULE}`;

const PAGE_CHARS = 6_000;
const HIRING_PAGE_CHARS = 9_000;

/**
 * Turns what was actually retrieved into a brief. With nothing retrieved the
 * model is not asked at all: code writes a brief that says so, because a model
 * given an empty page and a company name will happily describe the company.
 */
export async function writeCompanyBrief(input: BriefInput, llm: LlmClient, embedder: Embedder = lexicalEmbedder()): Promise<BriefResult> {
  const pages = [input.home, input.about, input.hiring].filter((page): page is CrawledPage => Boolean(page?.text));
  if (pages.length === 0 && input.discussion.length === 0) return nothingFound(input);

  const blocks = [
    ...pages.map((page) =>
      page === input.hiring
        ? // Not the top of a long page, but the lines from all over it that talk about the process.
          wrapUntrusted("hiring_page", `${page.title}\n${processDigest(page.text, { strong: STAGE_TERMS, weak: PROCESS_TERMS }, HIRING_PAGE_CHARS)}`, HIRING_PAGE_CHARS + 200)
        : wrapUntrusted("company_page", `${page.title}\n${page.text}`, PAGE_CHARS),
    ),
    ...(input.discussion.length > 0
      ? [wrapUntrusted("public_discussion", input.discussion.map((snippet) => `- ${snippet.text}`).join("\n"), PAGE_CHARS)]
      : []),
  ];

  const proposed = await llm.generate({
    step: "company-brief",
    system: SYSTEM,
    prompt: `Company: ${input.company || "name not known"}\n${input.hiring ? "" : "No page describing the hiring process was found, so hiring_stages must be empty.\n"}\n${blocks.join("\n\n")}`,
    schema: ProposedBriefSchema,
    maxOutputTokens: 1_500,
  });

  // The same rule as for requirements: the model quotes, code checks the quote is there, and then that it says what is claimed.
  const stages = await checkSupport(proposed.hiring_stages.map(({ stage, evidence }) => ({ text: stage, evidence })), input.hiring?.text ?? "", embedder);
  // An insight is checked against the one snippet its quote comes from, so the kit can say where it was said.
  const insights = await checkInsights(proposed.interview_insights.map(({ insight, evidence }) => ({ text: insight, evidence })), input.discussion, embedder);

  const interviewInsights = insights.kept.map((claim) => claim.text);
  return {
    brief: {
      summary: proposed.summary.trim(),
      what_they_do: proposed.what_they_do.trim(),
      // A source is listed only if something from it ended up in the kit. Search results that matched
      // the company's name but turned out to be about something else are not sources.
      sources: [...pages.map((page) => page.url), ...(interviewInsights.length > 0 ? input.discussion.map((snippet) => snippet.url) : [])],
      origin: "generated",
    },
    hiringStages: stages.kept.map((claim) => claim.text),
    interviewInsights,
    evidence: [
      ...stages.kept.map((claim) => ({ claim: claim.text, quote: claim.quote, source: "hiring-page" as const, url: input.hiring!.url })),
      ...insights.kept.map((claim) => ({ claim: claim.text, quote: claim.quote, source: "public-discussion" as const, ...(claim.url ? { url: claim.url } : {}) })),
    ],
    rejected: [
      ...stages.dropped.map((claim) => `hiring stage "${claim.text}": ${claim.reason}`),
      ...insights.dropped.map((claim) => `interview insight "${claim.text}": ${claim.reason}`),
    ],
  };
}

/**
 * Each insight is checked against the one snippet its quote comes from, never against all of them joined:
 * a quote that only exists across the seam between two people's comments was said by nobody.
 */
async function checkInsights(claims: Array<{ text: string; evidence: string }>, discussion: DiscussionSnippet[], embedder: Embedder) {
  const kept: Array<SupportResult["kept"][number] & { url?: string }> = [];
  const dropped: SupportResult["dropped"] = [];
  for (const claim of claims) {
    const said = discussion.find((snippet) => isQuotedFrom(snippet.text, claim.evidence));
    const checked = await checkSupport([claim], said?.text ?? "", embedder);
    kept.push(...checked.kept.map((supported) => ({ ...supported, url: said?.url })));
    dropped.push(...checked.dropped);
  }
  return { kept, dropped };
}

function nothingFound(input: BriefInput): BriefResult {
  const why = input.siteFailure ? `The company site could not be read: ${input.siteFailure}` : "The company site had no readable content.";
  return {
    brief: {
      summary: `No information about ${input.company || "this company"} could be retrieved. ${why} No public discussion of its interviews was found either. This brief is left empty rather than guessed.`,
      what_they_do: "Unknown: nothing could be retrieved. Check the company's site yourself before the interview.",
      sources: [],
      origin: "generated",
    },
    hiringStages: [],
    interviewInsights: [],
    evidence: [],
    rejected: [],
  };
}
