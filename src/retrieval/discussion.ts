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

interface Source {
  name: string;
  url: (query: string) => string;
  /** Sent to this source's own origin only, and never recorded. */
  headers?: Record<string, string>;
  /** For a source that takes its query in a JSON body rather than in the address. */
  body?: (query: string) => unknown;
  read: (body: unknown) => DiscussionSnippet[];
}

export interface DiscussionOptions {
  /**
   * A LangSearch API key. Optional. Most of what is written about a company's interviews is on blogs and forums that
   * neither keyless source covers, and a general web search finds it. LangSearch has a free plan with a daily allowance,
   * and a kit makes one search. Without a key nothing changes, which is how an evaluator's clean clone runs.
   */
  langSearchApiKey?: string;
}

/**
 * Sources of public discussion that need no key. Both are official APIs that permit
 * programmatic use. Reddit and Glassdoor were considered and left out: their
 * robots.txt and terms forbid unauthenticated automated access.
 */
const SOURCES: Source[] = [
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

/** A general web search, used only when a key is configured. Its results are strangers' text like any other and go through the same filters. */
const langSearch = (apiKey: string): Source => ({
  name: "web-search",
  url: () => "https://api.langsearch.com/v1/web-search",
  headers: { Authorization: `Bearer ${apiKey}` },
  body: (query) => ({ query: `${query} process experience`, count: 10, summary: false }),
  read: (body) =>
    langSearchResults(body).flatMap((result) =>
      typeof result.url === "string" && /^https?:\/\//.test(result.url) ? [{ source: "web-search", url: result.url, text: stripTags(`${result.name ?? ""} - ${result.snippet ?? result.summary ?? ""}`) }] : [],
    ),
});

interface LangSearchResult { name?: string; url?: string; snippet?: string; summary?: string }

/**
 * A search that found nothing answers with an empty list, and that is an honest "nothing found". Anything without the list
 * is not the response this was written for (an error body, a changed shape), and saying "nothing found" about it would be a
 * guess: it throws, and the source is logged as unreadable.
 */
function langSearchResults(body: unknown): LangSearchResult[] {
  const value = (body as { data?: { webPages?: { value?: unknown } | null } } | null)?.data?.webPages?.value;
  if (Array.isArray(value)) return value as LangSearchResult[];
  throw new Error("Unexpected web search response.");
}

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
export function createDiscussionSearch(fetcher: PageFetcher, options: DiscussionOptions = {}): DiscussionSearch {
  const sources = options.langSearchApiKey ? [...SOURCES, langSearch(options.langSearchApiKey)] : SOURCES;
  return async (company) => {
    const name = company.trim();
    if (name.length < 2) {
      return { snippets: [], log: [{ source: "public-discussion", outcome: "skipped", reason: "The company name is not known, so there was nothing to search for." }] };
    }

    const log: ResearchLogEntry[] = [];
    const snippets: DiscussionSnippet[] = [];
    const mentionsCompany = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

    await Promise.all(
      sources.map(async (source) => {
        const query = `"${name}" interview`;
        const url = source.url(query);
        const result = await fetcher.fetchPage(url, "json", source.headers || source.body ? { headers: source.headers, ...(source.body ? { jsonBody: source.body(query) } : {}) } : undefined);
        if (!result.ok) {
          log.push({ source: source.name, outcome: "skipped", reason: whyUnavailable(result) });
          return;
        }

        let relevant: DiscussionSnippet[] = [];
        try {
          relevant = source
            .read(JSON.parse(result.body))
            .filter((snippet) => mentionsCompany.test(snippet.text) && INTERVIEW_TERMS.test(snippet.text))
            .slice(0, Math.max(1, Math.floor(MAX_SNIPPETS / sources.length)))
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

/**
 * Said the way a person reading the kit would want it. A search service that is limiting requests answers 429, or, in
 * Stack Exchange's case, 400; either way the honest summary is that it would not answer just now, not "http_error".
 */
function whyUnavailable(result: { reason: string; detail: string; status?: number }): string {
  if (result.reason === "http_error" && (result.status === 429 || result.status === 400)) return `The service would not answer just now (HTTP ${result.status}); it is probably limiting requests. Regenerate the brief later to try again.`;
  if (result.reason === "http_error" && (result.status === 401 || result.status === 403)) return `The service refused the request (HTTP ${result.status}); if it needs a key, the key was not accepted.`;
  if (result.reason === "timeout" || result.reason === "network") return "The service could not be reached.";
  return `${result.reason}: ${result.detail}`;
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
