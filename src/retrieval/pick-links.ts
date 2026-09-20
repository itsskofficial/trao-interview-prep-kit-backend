import { z } from "zod";
import type { LlmClient } from "../llm/types";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../llm/untrusted";

/** A same-site link the crawl saw and did not follow. */
export interface LinkCandidate {
  url: string;
  text: string;
}

/**
 * Asked only when the crawl has finished without finding a page that describes
 * a hiring process. Returns the candidates worth one more fetch, best first.
 * It proposes; the crawl still decides, from the fetched page's own text,
 * whether any of them is a hiring page.
 */
export type LinkPicker = (candidates: LinkCandidate[], company: string) => Promise<LinkCandidate[]>;

export const SYSTEM = `You are helping find the page on a company's website that describes how the company hires: its interview stages, what candidates can expect, how to prepare.

You are given links from the site that were not followed, each with a number, its link text and its path. Link ranking by keywords has already failed, so the page, if it exists, has an unusual name: "Life at Acme", "How we work", "Join the crew", "Arbeiten bei uns", "Trabaja con nosotros".

Rules:
- Return the numbers of at most three links most likely to describe the hiring process, or to lead directly to it, best first.
- If none plausibly does, return an empty list. Most sites have no such page; an empty list is a good answer.
- Judge by the link text and path only. Do not guess at pages that are not listed.
- ${UNTRUSTED_CONTENT_RULE}`;

const PickSchema = z.object({ links: z.array(z.number().int()) });

const MAX_CANDIDATES = 60;
const MAX_PICKS = 3;

export function createLinkPicker(llm: LlmClient): LinkPicker {
  return async (candidates, company) => {
    const listed = candidates.slice(0, MAX_CANDIDATES);
    if (listed.length === 0) return [];

    const lines = listed.map((link, index) => `${index + 1}. "${link.text.replace(/\s+/g, " ").trim().slice(0, 80)}" ${pathOf(link.url)}`);
    const answer = await llm.generate({
      step: "pick-links",
      system: SYSTEM,
      prompt: `Company: ${company || "name not known"}\n\n${wrapUntrusted("site_links", lines.join("\n"), 8_000)}`,
      schema: PickSchema,
      maxOutputTokens: 200,
    });

    // Numbers the model made up, and repeats, are dropped here rather than trusted.
    const picked = [...new Set(answer.links)].filter((number) => number >= 1 && number <= listed.length).slice(0, MAX_PICKS);
    return picked.map((number) => listed[number - 1]!);
  };
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname).slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}
