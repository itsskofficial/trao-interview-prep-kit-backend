import { describe, expect, it } from "vitest";
import { createDiscussionSearch } from "../src/retrieval/discussion";
import type { FetchResult, PageFetcher } from "../src/retrieval/fetcher";

function fetcherReturning(answer: (url: string) => FetchResult): PageFetcher & { urls: string[] } {
  const urls: string[] = [];
  return { urls, close: async () => undefined, fetchPage: async (url) => (urls.push(url), answer(url)) };
}

const json = (url: string, body: unknown): FetchResult => ({ ok: true, url, status: 200, contentType: "application/json", body: JSON.stringify(body) });

describe("public discussion search", () => {
  it("keeps only results that name the company and talk about interviewing", async () => {
    const fetcher = fetcherReturning((url) =>
      url.includes("hn.algolia.com")
        ? json(url, {
            hits: [
              { objectID: "1", comment_text: "I interviewed at <b>Initech</b> last year: a phone screen, then pair programming." },
              { objectID: "2", comment_text: "Initech's logging product is decent." },
              { objectID: "3", comment_text: "My interview at Globex had five rounds." },
            ],
          })
        : json(url, { items: [] }),
    );
    const result = await createDiscussionSearch(fetcher)("Initech");

    expect(result.snippets).toEqual([
      { source: "hacker-news", url: "https://news.ycombinator.com/item?id=1", text: "I interviewed at Initech last year: a phone screen, then pair programming." },
    ]);
    expect(result.log).toEqual([
      { source: "hacker-news", outcome: "used", reason: "1 relevant result(s)" },
      { source: "stack-exchange-workplace", outcome: "empty", reason: "No public discussion of interviewing at Initech was found." },
    ]);
  });

  it("searches for the exact company name", async () => {
    const fetcher = fetcherReturning((url) => json(url, {}));
    await createDiscussionSearch(fetcher)("Acme Logistics");
    expect(fetcher.urls.every((url) => decodeURIComponent(url).includes('"Acme Logistics" interview'))).toBe(true);
  });

  it("records a source that cannot be reached as skipped, and carries on with the others", async () => {
    const fetcher = fetcherReturning((url) =>
      url.includes("hn.algolia.com") ? { ok: false, url, reason: "timeout", detail: "The site did not respond in time." } : json(url, { items: [] }),
    );
    const result = await createDiscussionSearch(fetcher)("Initech");
    expect(result.snippets).toEqual([]);
    expect(result.log[0]).toEqual({ source: "hacker-news", outcome: "skipped", reason: "The service could not be reached." });
    expect(result.log[1]).toMatchObject({ source: "stack-exchange-workplace", outcome: "empty" });
  });

  it("says in plain words when a source is limiting requests or refusing a key", async () => {
    const failing = (status: number) => fetcherReturning((url) => (url.includes("stackexchange") ? { ok: false, url, reason: "http_error", detail: `HTTP ${status}`, status } : json(url, { hits: [] })));
    const reasonFor = async (status: number) => (await createDiscussionSearch(failing(status))("Initech")).log.find((entry) => entry.source === "stack-exchange-workplace")!.reason;

    expect(await reasonFor(400)).toContain("probably limiting requests");
    expect(await reasonFor(429)).toContain("probably limiting requests");
    expect(await reasonFor(403)).toContain("the key was not accepted");

    // From a source that does not throttle this way, a 400 is a malformed request and keeps its diagnosis.
    const hn = fetcherReturning((url) => (url.includes("algolia") ? { ok: false, url, reason: "http_error", detail: "HTTP 400", status: 400 } : json(url, { items: [] })));
    expect((await createDiscussionSearch(hn)("Initech")).log.find((entry) => entry.source === "hacker-news")!.reason).toBe("http_error: HTTP 400");
  });

  it("survives a response that is not the JSON it expected", async () => {
    const fetcher = fetcherReturning((url) => ({ ok: true, url, status: 200, contentType: "application/json", body: "<html>rate limited</html>" }));
    const result = await createDiscussionSearch(fetcher)("Initech");
    expect(result.log.every((entry) => entry.outcome === "skipped")).toBe(true);
  });

  it("does not search when the company name is unknown", async () => {
    const fetcher = fetcherReturning((url) => json(url, {}));
    const result = await createDiscussionSearch(fetcher)("");
    expect(fetcher.urls).toEqual([]);
    expect(result.log).toEqual([expect.objectContaining({ source: "public-discussion", outcome: "skipped" })]);
  });
});

describe("the optional web search", () => {
  // The host, parsed: a substring test would also match evil.example/?next=api.langsearch.com.
  const isSearch = (url: string) => new URL(url).hostname === "api.langsearch.com";
  const keyless = (url: string) => json(url, url.includes("algolia") ? { hits: [] } : { items: [] });
  const found = (url: string) =>
    json(url, {
      code: 200,
      data: {
        webPages: {
          value: [
            { name: "My Initech interview", url: "https://blog.example/initech-interview", snippet: "The <strong>Initech</strong> interview was a recruiter call and then a take-home." },
            { name: "Initech pricing", url: "https://initech.example/pricing", snippet: "Plans start at $9." },
            { name: "Initech interview", url: "javascript:alert(1)", snippet: "Initech interview, from an address that is not a web page." },
          ],
        },
      },
    });

  it("is not asked without a key, so a clean clone behaves exactly as before", async () => {
    const fetcher = fetcherReturning(keyless);
    await createDiscussionSearch(fetcher)("Initech");
    expect(fetcher.urls.some(isSearch)).toBe(false);
  });

  it("adds relevant results when a key is configured, through the same filters as every other source", async () => {
    const seen: Array<{ url: string; headers?: Record<string, string>; jsonBody?: unknown }> = [];
    const fetcher: PageFetcher = {
      close: async () => undefined,
      fetchPage: async (url, _accept, options) => {
        seen.push({ url, headers: options?.headers, jsonBody: options?.jsonBody });
        return isSearch(url) ? found(url) : keyless(url);
      },
    };
    const result = await createDiscussionSearch(fetcher, { langSearchApiKey: "a-secret-key" })("Initech");

    expect(result.snippets).toEqual([{ source: "web-search", url: "https://blog.example/initech-interview", text: "My Initech interview - The Initech interview was a recruiter call and then a take-home." }]);
    expect(result.log).toContainEqual({ source: "web-search", outcome: "used", reason: "1 relevant result(s)" });

    // The query travels in the body and the key in a header, to that one service. Neither is ever part of an address.
    const asked = seen.find((request) => isSearch(request.url))!;
    expect(asked.url).toBe("https://api.langsearch.com/v1/web-search");
    expect(asked.headers).toEqual({ Authorization: "Bearer a-secret-key" });
    expect(asked.jsonBody).toMatchObject({ query: expect.stringContaining('"Initech" interview'), count: 10 });
    expect(seen.map((request) => request.url).join(" ")).not.toContain("a-secret-key");
    expect(seen.filter((request) => !isSearch(request.url)).every((request) => request.headers === undefined && request.jsonBody === undefined)).toBe(true);
  });

  it("says it could not read a response it does not recognise, rather than reporting that nothing was found", async () => {
    const answers = (body: unknown): PageFetcher => ({ close: async () => undefined, fetchPage: async (url) => (isSearch(url) ? json(url, body) : keyless(url)) });
    const logOf = async (body: unknown) => (await createDiscussionSearch(answers(body), { langSearchApiKey: "k" })("Initech")).log.find((entry) => entry.source === "web-search");

    expect(await logOf({ code: 429, msg: "daily allowance used" })).toMatchObject({ outcome: "skipped" });
    expect(await logOf({ data: { webPages: { value: "soon" } } })).toMatchObject({ outcome: "skipped" });
    expect(await logOf({ data: { queryContext: { originalQuery: "x" } } })).toMatchObject({ outcome: "skipped" });
    // A search that found nothing still answers with a list, an empty one, and that is a real "nothing found".
    expect(await logOf({ data: { webPages: { value: [] } } })).toMatchObject({ outcome: "empty" });
  });
});
