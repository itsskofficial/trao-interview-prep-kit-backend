import * as cheerio from "cheerio";
import type { ResearchLogEntry } from "../kit/schema";
import type { FetchResult, PageFetcher } from "./fetcher";
import { cleanHtml, type PageLink } from "./html";
import { byScore, rankLink, type RankedLink } from "./rank-links";

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  depth: number;
  /** How strongly the page's own text describes a hiring process. 0 means it does not. */
  processScore: number;
  aboutScore: number;
}

export interface SiteCrawl {
  reachable: boolean;
  /** Why the site could not be read, when it could not. */
  failure?: string;
  siteName: string;
  home?: CrawledPage;
  about?: CrawledPage;
  /** The page that describes how the company hires, if the site has one. */
  hiring?: CrawledPage;
  pages: CrawledPage[];
  log: ResearchLogEntry[];
}

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
}

/** Words that appear when a page describes a hiring process rather than just listing jobs. */
export const PROCESS_TERMS = [
  "interview", "hiring process", "recruiter", "phone screen", "screening call", "take-home", "take home", "coding challenge",
  "technical assessment", "assessment", "pair programming", "pairing session", "system design", "onsite", "on-site",
  "final round", "stage", "round", "offer", "hiring manager", "reference check", "values interview", "work sample",
];
/** Terms that name a stage outright, as opposed to words that merely turn up around hiring. */
export const STAGE_TERMS = [
  "phone screen", "screening call", "recruiter call", "take-home", "take home", "coding challenge", "technical assessment",
  "technical interview", "pair programming", "pairing session", "system design", "onsite", "on-site", "final round",
  "values interview", "culture interview", "work sample", "superday", "reference check", "offer",
];

/** "Stage", "round" and "offer" also describe funding and pricing, so one of these must be present too. */
const PROCESS_ANCHORS = ["interview", "hiring process", "how we hire", "recruit"];
const MIN_PROCESS_TERMS = 3;
const MAX_PAGE_TEXT_CHARS = 80_000;
/** A page this clearly about the process ends the search for a better one. */
const CONFIDENT_PROCESS_TERMS = 6;

/**
 * Crawls one company site: homepage, then the best-ranked same-site links,
 * then the best links found on those, within a page and depth budget. A page
 * counts as the hiring page only if its own text describes a process; a link
 * called "Careers" that leads to a job list does not qualify.
 */
export async function crawlCompanySite(companyUrl: string, fetcher: PageFetcher, options: CrawlOptions = {}): Promise<SiteCrawl> {
  const { maxPages = 12, maxDepth = 2 } = options;
  const log: ResearchLogEntry[] = [];
  const pages: CrawledPage[] = [];

  const homeResult = await fetcher.fetchPage(companyUrl);
  if (!homeResult.ok) {
    log.push({ source: "company-site", url: homeResult.url, outcome: "failed", reason: describe(homeResult) });
    return { reachable: false, failure: describe(homeResult), siteName: "", pages, log };
  }

  const origin = new URL(homeResult.url).origin;
  const visited = new Set<string>([normaliseUrl(homeResult.url), normaliseUrl(companyUrl)]);
  const queue: RankedLink[] = [];

  const visit = (result: Extract<FetchResult, { ok: true }>, depth: number, parent?: RankedLink): CrawledPage => {
    // Kept long: a handbook page can bury the stages tens of thousands of characters in. The brief step picks its excerpt.
    const clean = cleanHtml(result.body, result.url, MAX_PAGE_TEXT_CHARS);
    const page: CrawledPage = {
      url: result.url,
      title: clean.title,
      text: clean.text,
      depth,
      processScore: countProcessTerms(clean.text),
      aboutScore: parent?.aboutScore ?? 0,
    };
    pages.push(page);
    log.push({ source: "company-site", url: result.url, outcome: clean.text.length > 0 ? "used" : "empty", ...(clean.text.length === 0 ? { reason: "The page has no readable text; it may need JavaScript to render." } : {}) });

    if (depth < maxDepth) enqueue(clean.links, depth + 1, Math.max(parent?.hiringScore ?? 0, page.processScore >= MIN_PROCESS_TERMS ? 9 : 0));
    return page;
  };

  const enqueue = (links: PageLink[], depth: number, parentHiringScore: number) => {
    for (const link of links) {
      if (new URL(link.url).origin !== origin || visited.has(normaliseUrl(link.url))) continue;
      const ranked = rankLink(link, depth, parentHiringScore);
      if (ranked && !queue.some((queued) => normaliseUrl(queued.url) === normaliseUrl(ranked.url))) queue.push(ranked);
    }
  };

  const home = visit(homeResult, 0);
  enqueue(await sitemapLinks(homeResult.url, fetcher, log), 1, 0);

  while (pages.length < maxPages && queue.length > 0) {
    queue.sort(byScore);
    const next = queue.shift()!;
    if (visited.has(normaliseUrl(next.url))) continue;
    visited.add(normaliseUrl(next.url));

    const result = await fetcher.fetchPage(next.url);
    if (!result.ok) {
      log.push({ source: "company-site", url: result.url, outcome: "skipped", reason: describe(result) });
      continue;
    }
    visited.add(normaliseUrl(result.url));
    const page = visit(result, next.depth, next);

    // Enough: a page that is unmistakably about the process, and something that says what the company does.
    const hasAbout = pages.some((candidate) => candidate.aboutScore >= 5);
    if (page.processScore >= CONFIDENT_PROCESS_TERMS && hasAbout) break;
  }

  const hiring = pages
    .filter((page) => page.processScore >= MIN_PROCESS_TERMS)
    .sort((a, b) => b.processScore - a.processScore)[0];
  const about = pages
    .filter((page) => page !== home && page !== hiring && page.aboutScore > 0 && page.text.length > 0)
    .sort((a, b) => b.aboutScore - a.aboutScore || b.text.length - a.text.length)[0];

  log.push(
    hiring
      ? { source: "hiring-page", url: hiring.url, outcome: "used" }
      : { source: "hiring-page", outcome: "empty", reason: `No page describing a hiring process was found among the ${pages.length} page(s) read on this site.` },
  );

  return { reachable: true, siteName: siteName(homeResult.body, home.title), home, about, hiring, pages, log };
}

function countProcessTerms(text: string): number {
  const lower = text.toLowerCase();
  if (!PROCESS_ANCHORS.some((term) => lower.includes(term))) return 0;
  // "Interview" alone is what a job list says too; a process page uses several of these together.
  return PROCESS_TERMS.filter((term) => lower.includes(term)).length;
}

/** sitemap.xml next to the company URL, when there is one. Its entries are ranked like any other link. */
async function sitemapLinks(homeUrl: string, fetcher: PageFetcher, log: ResearchLogEntry[]): Promise<PageLink[]> {
  const sitemapUrl = new URL("sitemap.xml", homeUrl).href;
  const result = await fetcher.fetchPage(sitemapUrl, "xml");
  if (!result.ok) return [];

  const $ = cheerio.load(result.body, { xml: true });
  const links = $("url > loc")
    .map((_, element) => $(element).text().trim())
    .get()
    .slice(0, 500)
    .flatMap((loc): PageLink[] => {
      try {
        return [{ url: new URL(loc, sitemapUrl).href, text: "", region: "body" }];
      } catch {
        return [];
      }
    });
  log.push({ source: "sitemap", url: sitemapUrl, outcome: links.length > 0 ? "used" : "empty" });
  return links;
}

const GENERIC_TITLE = /^(home|homepage|welcome|index|careers?|jobs|about( us)?)$/i;

/** og:site_name if the site declares one, otherwise the least generic part of the homepage title. */
function siteName(html: string, title: string): string {
  const declared = cheerio.load(html)('meta[property="og:site_name"]').attr("content")?.trim();
  if (declared) return declared;
  const parts = title.split(/\s+[|–—·-]\s+|:\s+/).map((part) => part.trim()).filter((part) => part && !GENERIC_TITLE.test(part));
  return parts.sort((a, b) => a.length - b.length)[0] ?? "";
}

function normaliseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/(index\.html?)?$/i, "") || "/";
  return parsed.href;
}

function describe(result: Extract<FetchResult, { ok: false }>): string {
  const reasons: Record<typeof result.reason, string> = {
    invalid_url: "The address is not a valid web URL.",
    blocked_address: "The address points to a private or internal network.",
    robots_disallowed: "The site's robots.txt does not allow this page to be fetched.",
    http_error: `The site answered with HTTP ${result.status ?? "error"}.`,
    timeout: "The site did not respond in time.",
    network: "The site could not be reached.",
    unsupported_content_type: "The address does not serve a web page.",
    too_large: "The page is too large to process.",
    too_many_redirects: "The address redirects too many times.",
  };
  return reasons[result.reason];
}
