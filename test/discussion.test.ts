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
    expect(result.log[0]).toEqual({ source: "hacker-news", outcome: "skipped", reason: "timeout: The site did not respond in time." });
    expect(result.log[1]).toMatchObject({ source: "stack-exchange-workplace", outcome: "empty" });
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
