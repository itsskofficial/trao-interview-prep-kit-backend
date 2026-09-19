import type { ResearchLogEntry } from "../kit/schema";
import type { PageFetcher } from "./fetcher";

export interface DiscussionSnippet {
  source: string;
  url: string;
  text: string;
}

export interface DiscussionResult {
  snippets: DiscussionSnippet[];
  log: ResearchLogEntry[];
}

export type DiscussionSearch = (company: string) => Promise<DiscussionResult>;

/**
 * Sources of public discussion. Both are official, keyless APIs that permit
 * programmatic use. Reddit and Glassdoor were considered and left out: their
 * robots.txt and terms forbid unauthenticated automated access.
 */
const SOURCES: Array<{ name: string; url: (query: string) => string; read: (body: unknown) => DiscussionSnippet[] }> = [
  {
    name: "hacker-news",
    url: (query) => `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=(story,comment)&hitsPerPage=20`,
    read: (body) =>
      ((body as { hits?: HnHit[] }).hits ?? []).map((hit) => ({
        source: "hacker-news",
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        text: stripTags([hit.title, hit.story_title, hit.comment_text, hit.story_text].filter(Boolean).join(" - ")),
      })),
  },
  {
    name: "stack-exchange-workplace",
    url: (query) => `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&site=workplace&pagesize=10&q=${encodeURIComponent(query)}`,
    read: (body) =>
      ((body as { items?: SeItem[] }).items ?? []).map((item) => ({
        source: "stack-exchange-workplace",
        url: `https://workplace.stackexchange.com/q/${item.question_id}`,
        text: stripTags(`${item.title ?? ""} - ${item.excerpt ?? ""}`),
      })),
  },
];

interface HnHit { objectID: string; title?: string; story_title?: string; comment_text?: string; story_text?: string }
interface SeItem { question_id: number; title?: string; excerpt?: string }

const INTERVIEW_TERMS = /\b(interview|interviewed|interviewing|hiring process|recruiter|take[- ]home|onsite|on-site|offer|hired)\b/i;
const MAX_SNIPPETS = 6;
const MAX_SNIPPET_CHARS = 600;

/**
 * Looks for people discussing how this company interviews. A hit is kept only
 * if it names the company and talks about interviewing, because a search for a
 * common name returns plenty that does neither. Every source is logged as
 * used, empty or skipped; none of them can fail the run.
 */
export function createDiscussionSearch(fetcher: PageFetcher): DiscussionSearch {
  return async (company) => {
    const name = company.trim();
    if (name.length < 2) {
      return { snippets: [], log: [{ source: "public-discussion", outcome: "skipped", reason: "The company name is not known, so there was nothing to search for." }] };
    }

    const log: ResearchLogEntry[] = [];
    const snippets: DiscussionSnippet[] = [];
    const mentionsCompany = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

    await Promise.all(
      SOURCES.map(async (source) => {
        const url = source.url(`"${name}" interview`);
        const result = await fetcher.fetchPage(url, "json");
        if (!result.ok) {
          log.push({ source: source.name, outcome: "skipped", reason: `${result.reason}: ${result.detail}` });
          return;
        }

        let relevant: DiscussionSnippet[] = [];
        try {
          relevant = source
            .read(JSON.parse(result.body))
            .filter((snippet) => mentionsCompany.test(snippet.text) && INTERVIEW_TERMS.test(snippet.text))
            .slice(0, MAX_SNIPPETS / SOURCES.length)
            .map((snippet) => ({ ...snippet, text: snippet.text.slice(0, MAX_SNIPPET_CHARS) }));
        } catch {
          log.push({ source: source.name, outcome: "skipped", reason: "The response could not be read." });
          return;
        }

        snippets.push(...relevant);
        log.push(
          relevant.length > 0
            ? { source: source.name, outcome: "used", reason: `${relevant.length} relevant result(s)` }
            : { source: source.name, outcome: "empty", reason: `No public discussion of interviewing at ${name} was found.` },
        );
      }),
    );

    log.sort((a, b) => a.source.localeCompare(b.source));
    return { snippets, log };
  };
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;|&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
