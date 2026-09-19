import { afterEach, describe, expect, it } from "vitest";
import { crawlCompanySite } from "../src/retrieval/crawl";
import { createPageFetcher, type PageFetcher } from "../src/retrieval/fetcher";
import { startSite, type TestSite } from "./support/site";

/** Scenarios a code review found by reading the crawler against awkward sites. */

let site: TestSite | undefined;
let fetcher: PageFetcher | undefined;
afterEach(async () => {
  await fetcher?.close();
  await site?.close();
  site = fetcher = undefined;
});
const pages = () => (fetcher = createPageFetcher({ allowPrivate: true, localDelayMs: 0, retries: 0, timeoutMs: 1_000 }));
const process = "<h1>How we hire</h1><p>A recruiter call, a take-home exercise, a system design interview, then the final round. We make an offer within a week.</p>";

describe("the company's site is its own folder, not the whole origin", () => {
  it("does not take another company's hiring page from the same host", async () => {
    site = await startSite({
      "/acme/": '<a href="about.html">About us</a> <a href="../globex/careers.html">Careers at our sister company</a>',
      "/acme/about.html": "<p>Acme plans routes for couriers.</p>",
      "/globex/careers.html": process,
    });
    const crawl = await crawlCompanySite(`${site.origin}/acme/`, pages());

    expect(crawl.hiring).toBeUndefined();
    expect(site.hits).not.toContain("/globex/careers.html");
    expect(crawl.pages.every((page) => new URL(page.url).pathname.startsWith("/acme/"))).toBe(true);
  });

  it("works out the folder when the address has no trailing slash, and looks for the sitemap inside it", async () => {
    site = await startSite({
      "/acme": '<a href="/acme/hiring.html">How we interview</a> <a href="/globex/careers.html">Careers</a>',
      "/acme/hiring.html": process,
      "/globex/careers.html": process,
    });
    const crawl = await crawlCompanySite(`${site.origin}/acme`, pages());

    expect(new URL(crawl.hiring!.url).pathname).toBe("/acme/hiring.html");
    expect(site.hits).toContain("/acme/sitemap.xml");
    expect(site.hits).not.toContain("/sitemap.xml");
    expect(site.hits).not.toContain("/globex/careers.html");
  });

  it("refuses a page inside the folder that redirects out of it", async () => {
    site = await startSite({
      "/acme/": '<a href="careers/">Careers</a>',
      "/acme/careers/": { status: 302, headers: { location: "/globex/careers.html" } },
      "/globex/careers.html": process,
    });
    const crawl = await crawlCompanySite(`${site.origin}/acme/`, pages());
    expect(crawl.hiring).toBeUndefined();
    expect(crawl.log).toContainEqual(expect.objectContaining({ outcome: "skipped", reason: "The link leads outside this company's site." }));
  });

  it("still crawls a whole origin when the company is at its root", async () => {
    site = await startSite({ "/": '<a href="/people/joining">How we interview</a>', "/people/joining": process });
    expect(new URL((await crawlCompanySite(`${site.origin}/`, pages())).hiring!.url).pathname).toBe("/people/joining");
  });
});

describe("the crawl is bounded", () => {
  it("counts failed fetches against the budget", async () => {
    const links = Array.from({ length: 80 }, (_, i) => `<a href="/careers/role-${i}">Careers ${i}</a>`).join(" ");
    site = await startSite({ "/": links });
    await crawlCompanySite(`${site.origin}/`, pages(), { maxPages: 5 });
    // The homepage, robots.txt, the sitemap, and at most ten attempts.
    expect(site.hits.length).toBeLessThanOrEqual(13);
  });

  it("stops at its deadline and says so", async () => {
    site = await startSite({ "/": '<a href="/careers/">Careers</a> <a href="/about">About</a>', "/careers/": "<p>Jobs</p>", "/about": "<p>About</p>" });
    let clock = 0;
    const crawl = await crawlCompanySite(`${site.origin}/`, pages(), { deadlineMs: 1_000, now: () => (clock += 600) });
    expect(crawl.reachable).toBe(true);
    expect(crawl.log).toContainEqual(expect.objectContaining({ outcome: "skipped", reason: expect.stringContaining("Stopped reading the site") }));
  });

  it("survives a redirect whose Location is not a URL", async () => {
    site = await startSite({ "/": '<a href="/careers/">Careers</a>', "/careers/": { status: 302, headers: { location: "http://" } } });
    const crawl = await crawlCompanySite(`${site.origin}/`, pages());
    expect(crawl.reachable).toBe(true);
    expect(crawl.log).toContainEqual(expect.objectContaining({ url: `${site.origin}/careers/`, outcome: "skipped" }));
  });
});

describe("a careers page is not a hiring process", () => {
  it("is not fooled by 'around', 'background' and 'we offer'", async () => {
    site = await startSite({
      "/": '<a href="/careers/">Careers</a>',
      "/careers/": "<h1>Careers</h1><p>We're hiring engineers around the world, whatever your background. We offer competitive pay and a backstage pass to our roadmap. Apply and we will arrange an interview.</p>",
    });
    const crawl = await crawlCompanySite(`${site.origin}/`, pages());
    expect(crawl.hiring).toBeUndefined();
    expect(crawl.log.at(-1)).toMatchObject({ source: "hiring-page", outcome: "empty" });
  });
});
