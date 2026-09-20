import { z } from "zod";
import { wordOverlap } from "../extraction/evidence";
import type { Kit } from "../kit/schema";
import type { LlmClient } from "../llm/types";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../llm/untrusted";
import { PROCESS_TERMS, STAGE_TERMS, type CrawledPage } from "../retrieval/crawl";
import { processDigest } from "../retrieval/excerpt";
import type { DiscussionSnippet } from "../retrieval/discussion";

const ProposedBriefSchema = z.object({
  summary: z.string(),
  what_they_do: z.string(),
  hiring_stages: z.array(z.string()),
  interview_insights: z.array(z.string()),
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
}

export const SYSTEM = `You write a short, factual company brief for someone preparing for an interview there.

Rules:
- Use only what the supplied pages and discussion say. If they do not say something, leave it out. Never fill gaps from general knowledge.
- "summary": two or three sentences on who the company is.
- "what_they_do": the product or service and who it is for, in plain words.
- "hiring_stages": the stages of the hiring process in order, each as a short phrase, ONLY if a supplied page describes them. Otherwise an empty list.
- "interview_insights": what the public discussion says about interviewing at this company, ONLY if it is clearly about this company. Otherwise an empty list.
- ${UNTRUSTED_CONTENT_RULE}`;

const PAGE_CHARS = 6_000;
const HIRING_PAGE_CHARS = 9_000;

/**
 * Turns what was actually retrieved into a brief. With nothing retrieved the
 * model is not asked at all: code writes a brief that says so, because a model
 * given an empty page and a company name will happily describe the company.
 */
export async function writeCompanyBrief(input: BriefInput, llm: LlmClient): Promise<BriefResult> {
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

  // The same rule as for requirements: a stage or insight must be traceable to the text it claims to come from.
  const hiringText = input.hiring?.text ?? "";
  const discussionText = input.discussion.map((snippet) => snippet.text).join("\n");
  const grounded = (claims: string[], support: string) =>
    support ? claims.map((claim) => claim.trim()).filter((claim) => claim && wordOverlap(claim, support) >= 0.5) : [];

  const interviewInsights = grounded(proposed.interview_insights, discussionText);
  return {
    brief: {
      summary: proposed.summary.trim(),
      what_they_do: proposed.what_they_do.trim(),
      // A source is listed only if something from it ended up in the kit. Search results that matched
      // the company's name but turned out to be about something else are not sources.
      sources: [...pages.map((page) => page.url), ...(interviewInsights.length > 0 ? input.discussion.map((snippet) => snippet.url) : [])],
      origin: "generated",
    },
    hiringStages: grounded(proposed.hiring_stages, hiringText),
    interviewInsights,
  };
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
  };
}
