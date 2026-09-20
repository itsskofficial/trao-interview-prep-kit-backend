import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";
import { runBatch } from "../src/batch/run";
import { fakeClock, fakeLlmClient, fakeProvider } from "../src/llm/fake";
import { RateLimiter } from "../src/llm/rate-limiter";
import { createLlmClient } from "../src/llm/client";
import { ProviderError, type LlmCallRecord, type LlmProvider } from "../src/llm/types";
import { buildKit } from "../src/pipeline/build-kit";
import { PIPELINE_VERSION, promptFingerprint } from "../src/pipeline/generator";
import type { DiscussionSearch } from "../src/retrieval/discussion";
import { createPageFetcher, type PageFetcher } from "../src/retrieval/fetcher";
import { createTraceRecorder, tracedFetcher, type RunTrace } from "../src/trace/trace";
import { routedModel } from "./support/model";

const Fruits = z.object({ fruits: z.array(z.string()).min(1) });
const ask = (onCall: (record: LlmCallRecord) => void) => ({ step: "fruit", system: "Return JSON.", prompt: "List fruits.", schema: Fruits, onCall });

describe("what the model client reports about each call", () => {
  it("reports one record per HTTP call with the provider's own token counts", async () => {
    const provider: LlmProvider = { name: "counted", complete: async () => ({ text: '{"fruits":["fig"]}', usage: { inputTokens: 40, outputTokens: 9 } }) };
    const records: LlmCallRecord[] = [];
    await fakeLlmClient([provider]).generate(ask((record) => records.push(record)));

    expect(records).toEqual([
      { step: "fruit", provider: "counted", attempt: 1, kind: "answer", outcome: "ok", queuedMs: 0, latencyMs: 0, usage: { inputTokens: 40, outputTokens: 9 } },
    ]);
  });

  it("reports a retried call twice: what went wrong, then the answer", async () => {
    const records: LlmCallRecord[] = [];
    const provider = fakeProvider([new ProviderError("rate_limit", "slow down", 5_000), { fruits: ["kiwi"] }]);
    await fakeLlmClient([provider]).generate(ask((record) => records.push(record)));

    expect(records.map(({ attempt, outcome, error }) => ({ attempt, outcome, error }))).toEqual([
      { attempt: 1, outcome: "rate_limit", error: "slow down" },
      { attempt: 2, outcome: "ok", error: undefined },
    ]);
  });

  it("reports an answer that failed validation, and the repair that followed", async () => {
    const records: LlmCallRecord[] = [];
    await fakeLlmClient([fakeProvider(["not json", { fruits: ["plum"] }])]).generate(ask((record) => records.push(record)));

    expect(records.map(({ kind, outcome }) => ({ kind, outcome }))).toEqual([
      { kind: "answer", outcome: "invalid_output" },
      { kind: "repair", outcome: "ok" },
    ]);
  });

  it("reports both providers when the first is out of quota", async () => {
    const records: LlmCallRecord[] = [];
    const spent = fakeProvider([new ProviderError("quota_exhausted", "daily quota")], "first");
    await fakeLlmClient([spent, fakeProvider([{ fruits: ["pear"] }], "second")]).generate(ask((record) => records.push(record)));

    expect(records.map(({ provider, outcome }) => ({ provider, outcome }))).toEqual([
      { provider: "first", outcome: "quota_exhausted" },
      { provider: "second", outcome: "ok" },
    ]);
  });

  it("measures time queued in the rate limiter separately from the call itself", async () => {
    const clock = fakeClock();
    const slow: LlmProvider = {
      name: "slow",
      complete: async () => {
        await clock.sleep(700);
        return { text: '{"fruits":["date"]}' };
      },
    };
    const client = createLlmClient({ clock, providers: [{ provider: slow, limiter: new RateLimiter({ requestsPerMinute: 1, tokensPerMinute: 1_000_000 }, clock) }] });
    const records: LlmCallRecord[] = [];
    await client.generate(ask((record) => records.push(record)));
    await client.generate(ask((record) => records.push(record)));

    expect(records[0]).toMatchObject({ queuedMs: 0, latencyMs: 700 });
    // The second call waits for the first to leave the one-minute window before it is sent.
    expect(records[1]!.queuedMs).toBeGreaterThan(59_000);
    expect(records[1]!.latencyMs).toBe(700);
  });

  it("is not thrown off by an observer that throws: the answer stands and nothing is retried", async () => {
    const provider = fakeProvider([{ fruits: ["fig"] }]);
    const answer = await fakeLlmClient([provider]).generate(ask(() => { throw new Error("observer bug"); }));
    expect(answer).toEqual({ fruits: ["fig"] });
    expect(provider.requests).toHaveLength(1);
  });

  it("removes anything that looks like a credential from error text before it can be stored", async () => {
    const records: LlmCallRecord[] = [];
    const leaky = new ProviderError("bad_request", "Upstream said: Bearer abcdef1234567890 rejected for https://user:pass@host/v1?key=AIzaSyA1234567890abcdefghij_KLMN");
    await fakeLlmClient([fakeProvider([leaky])]).generate(ask((record) => records.push(record))).catch(() => undefined);
    expect(records[0]!.error).toBe("Upstream said: Bearer [redacted] rejected for https://[redacted]@host/v1?key=[redacted]");
  });

  it("keeps error text to one short line", async () => {
    const records: LlmCallRecord[] = [];
    const noisy = new ProviderError("bad_request", `Gemini 400: bad schema\n${"x".repeat(5_000)}`);
    await fakeLlmClient([fakeProvider([noisy])]).generate(ask((record) => records.push(record))).catch(() => undefined);
    expect(records[0]!.error).toBe("Gemini 400: bad schema");
  });
});

describe("rate limiter reservations", () => {
  it("frees budget when the call turned out smaller than estimated", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 100, tokensPerMinute: 1000 }, clock);
    (await limiter.acquire(800)).settle(200);
    await limiter.acquire(700);
    expect(clock.sleeps).toEqual([]);
  });

  it("charges more when the call turned out bigger than estimated", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 100, tokensPerMinute: 1000 }, clock);
    (await limiter.acquire(100)).settle(900);
    await limiter.acquire(200);
    expect(clock.sleeps).toEqual([60_001]);
  });

  it("keeps the estimate when nobody settles", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 100, tokensPerMinute: 1000 }, clock);
    await limiter.acquire(800);
    await limiter.acquire(300);
    expect(clock.sleeps).toEqual([60_001]);
  });

  it("is settled by the client from the provider's count", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 100, tokensPerMinute: 2_000 }, clock);
    // Estimated at about 1,500 tokens each; really 50. Without settling, the second call would wait a minute.
    const provider: LlmProvider = { name: "small", complete: async () => ({ text: '{"fruits":["fig"]}', usage: { inputTokens: 40, outputTokens: 10 } }) };
    const client = createLlmClient({ clock, providers: [{ provider, limiter }] });
    await client.generate(ask(() => undefined));
    await client.generate(ask(() => undefined));
    expect(clock.sleeps).toEqual([]);
  });
});

describe("trace recorder", () => {
  it("times steps, and marks a step that never finished", () => {
    let now = 1_000;
    const trace = createTraceRecorder(() => now);
    trace.step({ step: "extract", status: "started" });
    now += 300;
    trace.step({ step: "extract", status: "done", detail: "4 requirement(s)" });
    trace.step({ step: "crawl", status: "started" });
    now += 50;

    const finished = trace.finish("failed", "boom");
    expect(finished).toMatchObject({ outcome: "failed", error: "boom", durationMs: 350 });
    expect(finished.steps).toEqual([
      { step: "extract", status: "done", detail: "4 requirement(s)", atMs: 0, durationMs: 300 },
      { step: "crawl", status: "unfinished", atMs: 300, durationMs: 50 },
    ]);
  });

  it("totals calls, tokens, retries, repairs and failovers", () => {
    const trace = createTraceRecorder(() => 0);
    const call = (fields: Partial<LlmCallRecord>): LlmCallRecord => ({ step: "s", provider: "a", attempt: 1, kind: "answer", outcome: "ok", queuedMs: 5, latencyMs: 100, ...fields });
    trace.llmCall(call({ step: "one", outcome: "server" }));
    trace.llmCall(call({ step: "one", attempt: 2, usage: { inputTokens: 10, outputTokens: 4 } }));
    trace.llmCall(call({ step: "two", outcome: "invalid_output" }));
    trace.llmCall(call({ step: "two", kind: "repair", usage: { inputTokens: 20, outputTokens: 6 } }));
    trace.llmCall(call({ step: "three", outcome: "quota_exhausted" }));
    trace.llmCall(call({ step: "three", provider: "b" }));

    expect(trace.finish("ok").totals).toMatchObject({
      llmCalls: 6, llmMs: 600, queuedMs: 30, inputTokens: 30, outputTokens: 10, retries: 1, repairs: 1, failovers: 1, models: ["a", "b"],
    });
  });

  it("stops growing rather than becoming too large to store, while its totals stay true", () => {
    const trace = createTraceRecorder(() => 0);
    for (let i = 0; i < 2_000; i++) trace.decision("x", `decision ${i}`);
    for (let i = 0; i < 700; i++) trace.llmCall({ step: `s${i}`, provider: i < 650 ? "early" : "late", attempt: 1, kind: "answer", outcome: "ok", queuedMs: 0, latencyMs: 2, usage: { inputTokens: 1, outputTokens: 1 } });
    for (let i = 0; i < 600; i++) trace.fetch({ url: "https://x.test/", accept: "html", outcome: "ok", durationMs: 1, chars: 10 });

    const finished = trace.finish("ok");
    expect(finished.decisions).toHaveLength(500);
    expect(finished.llmCalls).toHaveLength(500);
    expect(finished.totals).toMatchObject({ llmCalls: 700, llmMs: 1400, inputTokens: 700, fetches: 600, pagesRead: 600, models: ["early", "late"] });
  });
});

describe("traced fetcher", () => {
  it("reports successes and failures, and hides query strings", async () => {
    const inner: PageFetcher = {
      fetchPage: async (url) => (url.includes("missing") ? { ok: false, url, reason: "http_error", detail: "", status: 404 } : { ok: true, url, status: 200, contentType: "text/html", body: "<p>hello</p>" }),
      close: async () => undefined,
    };
    const trace = createTraceRecorder(() => 0);
    const fetcher = tracedFetcher(inner, trace, () => 0);
    await fetcher.fetchPage("https://example.com/");
    await fetcher.fetchPage("https://example.com/missing");
    await fetcher.fetchPage("https://search.example/api?query=Acme+Corp", "json");

    expect(trace.finish("ok").fetches.map(({ url, accept, outcome, status, chars }) => ({ url, accept, outcome, status, chars }))).toEqual([
      { url: "https://example.com/", accept: "html", outcome: "ok", status: 200, chars: 12 },
      { url: "https://example.com/missing", accept: "html", outcome: "http_error", status: 404, chars: 0 },
      { url: "https://search.example/api?…", accept: "json", outcome: "ok", status: 200, chars: 12 },
    ]);
  });

  it("stores where a fetch went without credentials, query or fragment", async () => {
    const inner: PageFetcher = { fetchPage: async (url) => ({ ok: false, url, reason: "invalid_url", detail: "" }), close: async () => undefined };
    const trace = createTraceRecorder(() => 0);
    await tracedFetcher(inner, trace, () => 0).fetchPage("https://ada:hunter2@example.com/careers/how-we-hire?utm=x#stages");
    await tracedFetcher(inner, trace, () => 0).fetchPage("not a url");
    expect(trace.finish("ok").fetches.map((fetch) => fetch.url)).toEqual(["https://example.com/careers/how-we-hire?…", "[unparseable address]"]);
  });

  it("records a fetch that threw, and lets the error through", async () => {
    const inner: PageFetcher = { fetchPage: async () => { throw new Error("socket exploded"); }, close: async () => undefined };
    const trace = createTraceRecorder(() => 0);
    await expect(tracedFetcher(inner, trace, () => 0).fetchPage("https://example.com/a")).rejects.toThrow("socket exploded");
    expect(trace.finish("ok").fetches).toEqual([expect.objectContaining({ url: "https://example.com/a", outcome: "network", chars: 0 })]);
  });

  it("does not close the shared fetcher", async () => {
    let closed = false;
    const inner: PageFetcher = { fetchPage: async (url) => ({ ok: false, url, reason: "network", detail: "" }), close: async () => void (closed = true) };
    await tracedFetcher(inner, createTraceRecorder()).close();
    expect(closed).toBe(false);
  });
});

describe("a traced run", () => {
  const JD = "Backend Engineer\n\nRequirements\n- 5+ years with Node.js\n- PostgreSQL";
  const extraction = {
    title: "Backend Engineer", seniority: "", location: "", company: "", responsibilities: [],
    requirements: [
      { text: "5+ years with Node.js", evidence: "5+ years with Node.js", kind: "technical", priority: "must" },
      { text: "PostgreSQL", evidence: "PostgreSQL", kind: "technical", priority: "must" },
    ],
  };
  const noDiscussion: DiscussionSearch = async () => ({ snippets: [], log: [] });

  let site: FixtureServer;
  let fetcher: PageFetcher;
  beforeAll(async () => {
    site = await startFixtureServer();
    fetcher = createPageFetcher({ allowPrivate: true, localDelayMs: 0, retries: 0, timeoutMs: 2_000 });
  });
  afterAll(async () => {
    await fetcher.close();
    await site.close();
  });

  it("hands over a trace of every step, model call and fetch, and stamps the kit with what made it", async () => {
    const model = routedModel({ extract: extraction });
    const traces: RunTrace[] = [];
    const kit = await buildKit({ jd: JD, companyUrl: `${site.origin}/acme/`, days: 3 }, { llm: model.llm, fetcher, searchDiscussion: noDiscussion, onTrace: (trace) => traces.push(trace) });

    const [trace] = traces;
    expect(traces).toHaveLength(1);
    expect(trace!.outcome).toBe("ok");
    expect(trace!.steps.map((step) => step.step)).toEqual(["extract", "crawl", "discussion", "brief", "questions", "coverage", "flashcards", "schedule", "validate"]);
    expect(trace!.llmCalls).toHaveLength(model.requests.length);
    expect(trace!.llmCalls[0]).toMatchObject({ step: "extract-requirements", provider: "routed-fake", outcome: "ok" });
    expect(trace!.totals.llmCalls).toBe(model.requests.length);
    expect(trace!.totals.pagesRead).toBeGreaterThan(1);
    expect(trace!.fetches.every((fetch) => fetch.url.startsWith(site.origin))).toBe(true);

    expect(kit.generator).toEqual({ pipeline: PIPELINE_VERSION, prompts: promptFingerprint(), models: ["routed-fake"] });
  });

  it("holds no prompt, answer or page text", async () => {
    const model = routedModel({ extract: extraction });
    let trace: RunTrace | undefined;
    await buildKit({ jd: JD, companyUrl: `${site.origin}/acme/`, days: 3 }, { llm: model.llm, fetcher, searchDiscussion: noDiscussion, onTrace: (t) => (trace = t) });

    const stored = JSON.stringify(trace);
    expect(stored).not.toContain("PostgreSQL");
    expect(stored).not.toContain("You read one job description");
    expect(stored).not.toContain("route-planning");
  });

  it("still hands over a trace when the run fails, showing where it stopped", async () => {
    const model = routedModel({ extract: new ProviderError("auth", "GEMINI_API_KEY is not set.") });
    const traces: RunTrace[] = [];
    await buildKit({ jd: JD, companyUrl: `${site.origin}/acme/`, days: 3 }, { llm: model.llm, fetcher, onTrace: (trace) => traces.push(trace) }).catch(() => undefined);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ outcome: "failed", steps: [{ step: "extract", status: "failed" }] });
    expect(traces[0]!.llmCalls[0]).toMatchObject({ outcome: "auth" });
  });

  it("gives a batch one trace per case id, shared by identical cases", async () => {
    const model = routedModel({ extract: extraction });
    const seen: string[] = [];
    const same = { jd: JD, company_url: `${site.origin}/acme/`, days: 3 };
    await runBatch([{ id: "a", ...same }, { id: "b", ...same }, { id: "bad" }], { llm: model.llm, fetcher, searchDiscussion: noDiscussion, onCaseTrace: (id) => seen.push(id) });
    expect(seen.sort()).toEqual(["a", "b"]);
  });
});

describe("a batch case that ran out of time", () => {
  it("still hands over its trace, which shows where it was when it was stopped", async () => {
    // A model call that is still in flight when the case is given up on, and fails a moment later, as a cancelled request would.
    let release: () => void = () => undefined;
    const slow = { generate: () => new Promise<never>((_, reject) => (release = () => reject(new Error("stopped")))) };
    const seen: Array<{ id: string; outcome: string }> = [];
    const batch = runBatch([{ id: "slow", jd: "Engineer. Requirements: Go", company_url: "https://acme.example/", days: 2 }], {
      llm: slow,
      fetcher: { fetchPage: async (url) => ({ ok: false, url, reason: "network", detail: "" }), close: async () => undefined },
      caseTimeoutMs: 30,
      abandonGraceMs: 2_000,
      onCaseTrace: (id, trace) => seen.push({ id, outcome: trace.outcome }),
    });
    setTimeout(() => release(), 80);
    const output = await batch;

    expect(output.kits[0]).toMatchObject({ id: "slow", status: "failed", error: { code: "TIMEOUT" } });
    expect(seen).toEqual([{ id: "slow", outcome: "failed" }]);
  });
});

describe("prompt fingerprint", () => {
  it("changes when any prompt changes, and not otherwise", () => {
    expect(promptFingerprint(["a", "b"])).toBe(promptFingerprint(["a", "b"]));
    expect(promptFingerprint(["a", "b"])).not.toBe(promptFingerprint(["a", "b."]));
    // Moving text from one prompt to another is a change too.
    expect(promptFingerprint(["ab", "c"])).not.toBe(promptFingerprint(["a", "bc"]));
    expect(promptFingerprint()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("a run that has been given up on", () => {
  it("stops at the next step instead of fetching and assembling a kit nobody is waiting for", async () => {
    const abandoned = new AbortController();
    const fetched: string[] = [];
    const model = routedModel({
      extract: () => {
        abandoned.abort();
        return { title: "Engineer", seniority: "", location: "", company: "", responsibilities: [], requirements: [{ text: "PostgreSQL", evidence: "PostgreSQL", kind: "technical", priority: "must" }] };
      },
    });
    const traces: RunTrace[] = [];
    const run = buildKit(
      { jd: "Engineer\n\nRequirements\n- PostgreSQL", companyUrl: "https://acme.example/", days: 2 },
      { llm: model.llm, signal: abandoned.signal, onTrace: (trace) => traces.push(trace), fetcher: { fetchPage: async (url) => (fetched.push(url), { ok: false, url, reason: "network", detail: "" }), close: async () => undefined } },
    );

    await expect(run).rejects.toThrow();
    expect(fetched).toEqual([]);
    expect(traces[0]!.steps.map((step) => step.step)).toEqual(["extract"]);
  });
});
