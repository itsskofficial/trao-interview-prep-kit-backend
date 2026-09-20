import * as cheerio from "cheerio";
import type { ResearchLogEntry } from "../kit/schema";
import type { FetchResult, PageFetcher } from "./fetcher";
import { cleanHtml, type PageLink } from "./html";
import type { LinkCandidate, LinkPicker } from "./pick-links";
import { byScore, isFollowable, rankLink, type RankedLink } from "./rank-links";

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
  /** Wall-clock budget for the whole crawl. A slow site costs the research, not the kit. */
  deadlineMs?: number;
  now?: () => number;
  /**
   * Asked which unfollowed links to try when ranking by wording found no hiring page. Optional: without it the
   * crawl is code alone. Whatever it suggests is fetched and put to the same test as every other page.
   */
  pickLinks?: LinkPicker;
  /** For the picker's prompt, when the posting named the company. */
  company?: string;
}

/**
 * Wording that appears when a page describes a hiring process rather than just listing jobs.
 * Whole words only: "round" is not in "around", "stage" is not in "backstage", and a company
 * that says "we offer competitive pay" has not described an offer stage.
 */
export const PROCESS_TERMS: RegExp[] = [
  /\binterview(s|ed|ing|ers?)?\b/, /\bhiring process\b/, /\brecruiters?\b/, /\bphone screen\b/, /\bscreening call\b/,
  /\btake[- ]home\b/, /\bcoding challenge\b/, /\b(technical )?assessment\b/, /\bpair(ing)? (programming|session)\b/,
  /\bsystem design\b/, /\bon-?site\b/, /\bfinal round\b/, /\bhiring manager\b/, /\breference checks?\b/, /\bwork sample\b/,
  /\b(first|second|third|final|next|\d+(st|nd|rd|th)?) (round|stage)\b/, /\b(round|stage) (\d|one|two|three|four|five)\b/,
  /\b(make|makes|made|extend|extends|send|sends|receive) (you )?(an?|the|our) offer\b/, /\boffer (stage|call|letter)\b/,
];

/** Terms that name a stage outright, as opposed to words that merely turn up around hiring. */
export const STAGE_TERMS: RegExp[] = [
  /\bphone screen\b/, /\bscreening call\b/, /\brecruiter (call|screen)\b/, /\btake[- ]home\b/, /\bcoding challenge\b/,
  /\btechnical (assessment|interview|screen)\b/, /\bpair(ing)? (programming|session)\b/, /\bsystem design\b/, /\bon-?site\b/,
  /\bfinal round\b/, /\b(values|culture|cultural) interview\b/, /\bwork sample\b/, /\bsuperday\b/, /\breference checks?\b/,
  /\b(make|makes|made|extend|extends|send|sends) (you )?(an?|the|our) offer\b/, /\boffer (stage|call|letter)\b/,
];

/** A page must talk about interviewing or recruiting at all before its other process wording counts. */
const PROCESS_ANCHORS: RegExp[] = [/\binterview/, /\bhiring process\b/, /\bhow we hire\b/, /\brecruit/];
const MIN_PROCESS_TERMS = 3;
const MAX_PAGE_TEXT_CHARS = 80_000;
/** A page this clearly about the process ends the search for a better one. */
const CONFIDENT_PROCESS_TERMS = 6;
/**
 * Pages the link picker may add beyond `maxPages`. Deliberately outside the normal budget: the picker is only asked when
 * that budget has been spent without finding a hiring page, which is exactly when it would otherwise have nothing left.
 */
const PICKED_PAGES = 3;

/**
 * Crawls one company site: homepage, then the best-ranked same-site links,
 * then the best links found on those, within a page and depth budget. A page
 * counts as the hiring page only if its own text describes a process; a link
 * called "Careers" that leads to a job list does not qualify.
 */
export async function crawlCompanySite(companyUrl: string, fetcher: PageFetcher, options: CrawlOptions = {}): Promise<SiteCrawl> {
  const { maxPages = 12, maxDepth = 2, deadlineMs = 45_000, now = Date.now, pickLinks, company } = options;
  const startedAt = now();
  const log: ResearchLogEntry[] = [];
  const pages: CrawledPage[] = [];

  const homeResult = await fetcher.fetchPage(companyUrl);
  if (!homeResult.ok) {
    log.push({ source: "company-site", url: homeResult.url, outcome: "failed", reason: describe(homeResult) });
    return { reachable: false, failure: describe(homeResult), siteName: "", pages, log };
  }

  const origin = new URL(homeResult.url).origin;
  // Several companies can live under one origin (http://host/acme/, http://host/globex/). The company's
  // site is then everything under its own folder, and nothing beside it.
  const scope = siteScope(homeResult.url);
  const inScope = (url: string) => {
    const parsed = new URL(url);
    return parsed.origin === origin && (scope === "/" || parsed.pathname.startsWith(scope) || `${parsed.pathname}/` === scope);
  };
  const visited = new Set<string>([normaliseUrl(homeResult.url), normaliseUrl(companyUrl)]);
  const queue: RankedLink[] = [];
  // Every same-site link seen, whether or not its wording earned it a place in the queue.
  const seen = new Map<string, LinkCandidate>();

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
    log.push({
      source: "company-site",
      url: result.url,
      outcome: clean.text.length > 0 ? "used" : "empty",
      ...(clean.text.length === 0
        ? { reason: "The page has no readable text and none embedded in its HTML; it probably needs a browser to render." }
        : clean.textSource === "embedded"
          ? // Why the page showed so little is not known from here, only that it did.
            { reason: "The page showed almost no text of its own, so its text was read from content embedded in its HTML (noscript, page data, structured data or its description)." }
          : {}),
    });

    if (depth < maxDepth) enqueue(clean.links, depth + 1, Math.max(parent?.hiringScore ?? 0, page.processScore >= MIN_PROCESS_TERMS ? 9 : 0));
    return page;
  };

  const enqueue = (links: PageLink[], depth: number, parentHiringScore: number) => {
    for (const link of links) {
      if (!inScope(link.url) || visited.has(normaliseUrl(link.url))) continue;
      if (link.text.trim() && isFollowable(link) && !seen.has(normaliseUrl(link.url))) seen.set(normaliseUrl(link.url), { url: link.url, text: link.text });
      const ranked = rankLink(link, depth, parentHiringScore);
      if (ranked && !queue.some((queued) => normaliseUrl(queued.url) === normaliseUrl(ranked.url))) queue.push(ranked);
    }
  };

  const home = visit(homeResult, 0);
  enqueue(await sitemapLinks(new URL("sitemap.xml", `${origin}${scope}`).href, fetcher, log), 1, 0);

  // Failed fetches count too: a site whose every link errors must not be tried two hundred times.
  let attempts = 0;
  while (pages.length < maxPages && attempts < maxPages * 2 && queue.length > 0) {
    if (now() - startedAt > deadlineMs) {
      log.push({ source: "company-site", outcome: "skipped", reason: `Stopped reading the site after ${Math.round(deadlineMs / 1000)} seconds; ${queue.length} link(s) were not followed.` });
      break;
    }
    attempts++;
    queue.sort(byScore);
    const next = queue.shift()!;
    if (visited.has(normaliseUrl(next.url))) continue;
    visited.add(normaliseUrl(next.url));

    const result = await fetcher.fetchPage(next.url);
    if (!result.ok) {
      log.push({ source: "company-site", url: result.url, outcome: "skipped", reason: describe(result) });
      continue;
    }
    // A link inside the company's folder that redirects out of it has left the company's site.
    if (!inScope(result.url)) {
      log.push({ source: "company-site", url: result.url, outcome: "skipped", reason: "The link leads outside this company's site." });
      continue;
    }
    visited.add(normaliseUrl(result.url));
    const page = visit(result, next.depth, next);

    // Enough: a page that is unmistakably about the process, and something that says what the company does.
    const hasAbout = pages.some((candidate) => candidate.aboutScore >= 5);
    if (page.processScore >= CONFIDENT_PROCESS_TERMS && hasAbout) break;
  }

  // Ranking reads English hiring words. "Life at Acme" or "Arbeiten bei uns" never earns a fetch that way, so when
  // nothing was found, and only then, a model is shown the links that were passed over and may name three to try.
  const foundByWording = pages.some((page) => page.processScore >= MIN_PROCESS_TERMS);
  if (!foundByWording && pickLinks && now() - startedAt <= deadlineMs) {
    const candidates = [...seen.entries()].filter(([key]) => !visited.has(key)).map(([, link]) => link);
    // The model client has its own, longer patience and may retry. The crawl's deadline is the one that counts here.
    const remaining = Math.max(0, deadlineMs - (now() - startedAt));
    const picks = candidates.length > 0 ? await within(remaining, pickLinks(candidates, company || siteName(homeResult.body, home.title))).catch(() => undefined) : [];
    if (picks === undefined) {
      log.push({ source: "link-picker", outcome: "skipped", reason: "Asking a model which links to try failed; the crawl stands as it was." });
    } else if (candidates.length > 0) {
      log.push({
        source: "link-picker",
        outcome: picks.length > 0 ? "used" : "empty",
        reason:
          picks.length > 0
            ? `No link looked like a hiring page by its wording, so a model was shown the ${candidates.length} link(s) not followed and chose ${picks.length} to try.`
            : `No link looked like a hiring page by its wording. A model was shown the ${candidates.length} link(s) not followed and found none worth trying.`,
      });
    }

    for (const pick of (picks ?? []).slice(0, PICKED_PAGES)) {
      // Only what the crawl itself saw on this site: a made-up or off-site address is not fetched.
      const key = normaliseUrl(pick.url);
      if (!seen.has(key) || visited.has(key) || now() - startedAt > deadlineMs) continue;
      visited.add(key);
      const result = await fetcher.fetchPage(pick.url);
      if (!result.ok) {
        log.push({ source: "company-site", url: result.url, outcome: "skipped", reason: describe(result) });
        continue;
      }
      if (!inScope(result.url)) continue;
      const page = visit(result, 1);
      if (page.processScore >= MIN_PROCESS_TERMS) break;
    }
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

/** The promise, or a rejection once the time is up. The work is not cancelled, only no longer waited for. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("out of time")), ms)));
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function countProcessTerms(text: string): number {
  const lower = text.toLowerCase();
  if (!PROCESS_ANCHORS.some((term) => term.test(lower))) return 0;
  // "Interview" alone is what a job list says too; a process page uses several of these together.
  return PROCESS_TERMS.filter((term) => term.test(lower)).length;
}

/** The folder the company's site lives in: "/" for a whole origin, "/acme/" for http://host/acme/ or http://host/acme. */
function siteScope(homeUrl: string): string {
  const { pathname } = new URL(homeUrl);
  if (pathname.endsWith("/")) return pathname;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  // "/acme" names a folder; "/acme/index.html" names a file inside one.
  return last.includes(".") ? pathname.slice(0, pathname.lastIndexOf("/") + 1) : `${pathname}/`;
}

/** sitemap.xml next to the company URL, when there is one. Its entries are ranked like any other link. */
async function sitemapLinks(sitemapUrl: string, fetcher: PageFetcher, log: ResearchLogEntry[]): Promise<PageLink[]> {
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
