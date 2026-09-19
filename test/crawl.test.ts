import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";
import { crawlCompanySite } from "../src/retrieval/crawl";
import { createPageFetcher, type PageFetcher } from "../src/retrieval/fetcher";
import { rankLink } from "../src/retrieval/rank-links";

let site: FixtureServer;
let fetcher: PageFetcher;

beforeAll(async () => {
  site = await startFixtureServer();
  fetcher = createPageFetcher({ allowPrivate: true, localDelayMs: 0, timeoutMs: 2_000, retries: 0 });
});
afterAll(async () => {
  await fetcher.close();
  await site.close();
});

const pathOf = (url?: string) => (url ? new URL(url).pathname : undefined);

describe("rankLink", () => {
  const link = (url: string, text: string, region: "nav" | "footer" | "body" = "body") => ({ url: `http://x.test${url}`, text, region });

  it("ranks a link about interviewing above a careers link, and careers above a generic page", () => {
    const process = rankLink(link("/handbook/p/x.html", "How we interview and make offers"), 1)!;
    const careers = rankLink(link("/careers/", "Careers", "footer"), 1)!;
    const blog = rankLink(link("/blog/", "Blog", "nav"), 1)!;
    expect(process.score).toBeGreaterThan(careers.score);
    expect(careers.score).toBeGreaterThan(blog.score);
  });

  it("reads the path when the anchor text says nothing", () => {
    expect(rankLink(link("/company/hiring-process", "Learn more"), 1)!.hiringScore).toBeGreaterThan(0);
  });

  it("recognises an about page", () => {
    expect(rankLink(link("/who-we-are", "Who we are", "nav"), 1)!.aboutScore).toBeGreaterThan(0);
  });

  it("drops legal pages, logins, files and links with no signal", () => {
    for (const [url, text] of [["/privacy", "Privacy"], ["/login", "Sign in"], ["/brochure.pdf", "Careers brochure"], ["/pricing", "Pricing"]]) {
      expect(rankLink(link(url!, text!), 1)).toBeUndefined();
    }
  });

  it("follows vague links found on a page that is already about hiring", () => {
    expect(rankLink(link("/x/what-to-expect", "What to expect"), 2)).toBeUndefined();
    expect(rankLink(link("/x/what-to-expect", "What to expect"), 2, 9)).toBeDefined();
  });

  it("prefers the shallower of two equal links", () => {
    expect(rankLink(link("/careers/", "Careers"), 1)!.score).toBeGreaterThan(rankLink(link("/careers/", "Careers"), 2)!.score);
  });
});

describe("crawlCompanySite", () => {
  it("finds a hiring process two clicks deep at a path that could not be guessed", async () => {
    const crawl = await crawlCompanySite(`${site.origin}/acme/`, fetcher);
    expect(crawl.reachable).toBe(true);
    expect(pathOf(crawl.hiring?.url)).toBe("/acme/handbook/people/talent/stage-guide.html");
    expect(crawl.hiring!.text).toContain("Take-home exercise");
    expect(pathOf(crawl.about?.url)).toBe("/acme/about.html");
    expect(crawl.siteName).toBe("Acme Logistics");
    expect(crawl.log).toContainEqual({ source: "hiring-page", url: crawl.hiring!.url, outcome: "used" });
  });

  it("does not mistake a job list for a hiring process", async () => {
    const crawl = await crawlCompanySite(`${site.origin}/acme/`, fetcher);
    const careers = crawl.pages.find((page) => pathOf(page.url) === "/acme/careers/");
    expect(careers?.processScore ?? 0).toBeLessThan(3);
  });

  it("finds a process described in a blog post, and stays out of what robots.txt disallows", async () => {
    site.hits.length = 0;
    const crawl = await crawlCompanySite(`${site.origin}/initech/`, fetcher);
    expect(pathOf(crawl.hiring?.url)).toBe("/initech/blog/2025/03/how-we-hire-engineers/");
    expect(site.hits).not.toContain("/initech/internal/handbook.html");
    expect(crawl.log).toContainEqual(expect.objectContaining({ outcome: "skipped", reason: expect.stringContaining("robots.txt") }));
  });

  it("records a page that has no readable text because it needs JavaScript", async () => {
    const crawl = await crawlCompanySite(`${site.origin}/initech/`, fetcher);
    expect(crawl.log).toContainEqual(expect.objectContaining({ url: `${site.origin}/initech/careers/`, outcome: "empty" }));
  });

  it("reports honestly when a site has no hiring page anywhere", async () => {
    const crawl = await crawlCompanySite(`${site.origin}/globex/`, fetcher);
    expect(crawl.reachable).toBe(true);
    expect(crawl.hiring).toBeUndefined();
    expect(pathOf(crawl.about?.url)).toBe("/globex/about/");
    expect(crawl.log.at(-1)).toMatchObject({ source: "hiring-page", outcome: "empty" });
  });

  it("is not fooled by a funding 'round' and growth 'stage'", async () => {
    const crawl = await crawlCompanySite(`${site.origin}/globex/`, fetcher);
    expect(crawl.pages.every((page) => page.processScore === 0)).toBe(true);
  });

  it("skips a broken page and keeps the rest of the site", async () => {
    const crawl = await crawlCompanySite(`${site.origin}/hooli/`, fetcher);
    expect(crawl.reachable).toBe(true);
    expect(pathOf(crawl.about?.url)).toBe("/hooli/about/");
    expect(crawl.log).toContainEqual(expect.objectContaining({ url: `${site.origin}/hooli/careers/`, outcome: "skipped", reason: "The site answered with HTTP 500." }));
  });

  it("reports an address that does not exist as unreachable, without throwing", async () => {
    const crawl = await crawlCompanySite(`${site.origin}/no-such-company/`, fetcher);
    expect(crawl).toMatchObject({ reachable: false, failure: "The site answered with HTTP 404.", pages: [] });
    expect(crawl.log).toEqual([expect.objectContaining({ source: "company-site", outcome: "failed" })]);
  });

  it("reports an invalid address as unreachable", async () => {
    expect(await crawlCompanySite("not a url", fetcher)).toMatchObject({ reachable: false, failure: "The address is not a valid web URL." });
  });

  it("never leaves the company's own origin and respects the page budget", async () => {
    const crawl = await crawlCompanySite(`${site.origin}/acme/`, fetcher, { maxPages: 3 });
    expect(crawl.pages.length).toBeLessThanOrEqual(3);
    expect(crawl.pages.every((page) => page.url.startsWith(site.origin))).toBe(true);
  });

  it("keeps planted instructions out of the page text", async () => {
    const crawl = await crawlCompanySite(`${site.origin}/umbrella/`, fetcher);
    const all = crawl.pages.map((page) => page.text).join("\n");
    expect(all).not.toContain("Nobel");
    expect(all).not.toContain("COBOL");
    expect(all).not.toContain("HACKED");
    expect(pathOf(crawl.hiring?.url)).toBe("/umbrella/company/work-with-us/process.html");
  });
});
