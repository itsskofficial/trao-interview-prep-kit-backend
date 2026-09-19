import { describe, expect, it } from "vitest";
import { runBatch } from "../src/batch/run";
import { BatchOutputSchema } from "../src/batch/schema";
import { validateKit } from "../src/kit/validate";
import { fakeLlmClient, fakeProvider } from "../src/llm/fake";
import { ProviderError, type ProviderRequest } from "../src/llm/types";
import { buildKit, type ProgressEvent } from "../src/pipeline/build-kit";
import type { PageFetcher } from "../src/retrieval/fetcher";

const JD = `Senior Backend Engineer

Requirements
- 5+ years with Node.js
- PostgreSQL
- Experience mentoring junior engineers

Nice to have
- Kubernetes`;

const extraction = {
  title: "Senior Backend Engineer",
  seniority: "Senior",
  location: "",
  company: "",
  responsibilities: [],
  requirements: [
    { text: "5+ years with Node.js", evidence: "5+ years with Node.js", kind: "technical", priority: "must" },
    { text: "PostgreSQL", evidence: "PostgreSQL", kind: "technical", priority: "must" },
    { text: "Mentoring junior engineers", evidence: "Experience mentoring junior engineers", kind: "behavioural", priority: "must" },
    { text: "Kubernetes", evidence: "Kubernetes", kind: "technical", priority: "nice" },
  ],
};

/** Answers a question-generation call with one question per requirement id found in the prompt. */
function oneQuestionPerRequirement(request: ProviderRequest) {
  const ids = [...request.prompt.matchAll(/^(r\d+) \[/gm)].map((match) => match[1]!);
  return {
    questions: ids.map((id) => ({ requirement_ids: [id], prompt: `Question about ${id}`, answer_outline: "Outline", difficulty: 2 })),
  };
}

const NOW = () => new Date("2026-09-19T12:00:00Z");

/** Stands in for a company site that cannot be reached; retrieval has its own tests. */
const fetcher: PageFetcher = {
  fetchPage: async (url) => ({ ok: false, url, reason: "network", detail: "unreachable in this test" }),
  close: async () => undefined,
};
const input = { jd: JD, companyUrl: "http://localhost:8099/acme/", days: 5 };

describe("buildKit", () => {
  it("produces a structurally valid kit from the description alone", async () => {
    const llm = fakeLlmClient([fakeProvider([extraction, oneQuestionPerRequirement, oneQuestionPerRequirement])]);
    const kit = await buildKit(input, { llm, fetcher, now: NOW });

    expect(validateKit(kit)).toMatchObject({ ok: true });
    expect(kit.source).toMatchObject({ company_url: input.companyUrl, jd_chars: JD.length, researched_at: "2026-09-19T12:00:00.000Z" });
    expect(kit.role.requirements.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(kit.schedule.days).toHaveLength(5);
    expect(kit.coverage.uncovered_requirement_ids).toEqual([]);
  });

  it("generates technical and behavioural questions in separate calls with different instructions", async () => {
    const provider = fakeProvider([extraction, oneQuestionPerRequirement, oneQuestionPerRequirement]);
    const kit = await buildKit(input, { llm: fakeLlmClient([provider]), fetcher, now: NOW });

    const [, technical, behavioural] = provider.requests;
    expect(technical!.system).not.toEqual(behavioural!.system);
    expect(technical!.prompt).toContain("r1 [must]");
    expect(technical!.prompt).not.toContain("r3 [must]");
    expect(behavioural!.prompt).toContain("r3 [must]");
    expect(kit.questions.filter((q) => q.category === "behavioural").map((q) => q.requirement_ids)).toEqual([["r3"]]);
  });

  it("discards requirement ids the model made up", async () => {
    const madeUp = { questions: [{ requirement_ids: ["r1", "r99"], prompt: "P", answer_outline: "O", difficulty: 3 }] };
    const llm = fakeLlmClient([fakeProvider([extraction, madeUp, oneQuestionPerRequirement])]);
    const kit = await buildKit(input, { llm, fetcher, now: NOW });
    expect(kit.questions[0]!.requirement_ids).toEqual(["r1"]);
  });

  it("uses the requested number of days", async () => {
    const llm = fakeLlmClient([fakeProvider([extraction, oneQuestionPerRequirement, oneQuestionPerRequirement])]);
    const kit = await buildKit({ ...input, days: 60 }, { llm, fetcher, now: NOW });
    expect(kit.schedule.days_available).toBe(60);
    expect(kit.schedule.days).toHaveLength(60);
  });

  it("builds a thin, honest kit from a stub that states nothing", async () => {
    const nothing = { title: "", seniority: "", location: "", company: "", responsibilities: [], requirements: [] };
    const provider = fakeProvider([nothing]);
    const kit = await buildKit({ ...input, jd: "We are hiring! Apply now." }, { llm: fakeLlmClient([provider]), fetcher, now: NOW });

    expect(provider.requests).toHaveLength(1);
    expect(kit.role.requirements).toEqual([]);
    expect(kit.questions).toEqual([]);
    expect(kit.schedule.days).toHaveLength(5);
    expect(kit.notes!.join(" ")).toContain("deliberately thin");
  });

  it("reports progress for each step", async () => {
    const events: ProgressEvent[] = [];
    const llm = fakeLlmClient([fakeProvider([extraction, oneQuestionPerRequirement, oneQuestionPerRequirement])]);
    await buildKit(input, { llm, fetcher, now: NOW, onProgress: (event) => events.push(event) });
    expect(events.filter((e) => e.status === "done").map((e) => e.step)).toEqual(["extract", "questions", "coverage", "schedule", "validate"]);
    expect(events).toContainEqual({ step: "crawl", status: "failed", detail: "The site could not be reached." });
  });
});

describe("runBatch", () => {
  const goodCase = { id: "case-01", jd: JD, company_url: "http://localhost:8099/acme/", days: 3 };

  it("writes one entry per case and carries on after failures", async () => {
    const llm = fakeLlmClient([
      fakeProvider([
        extraction, oneQuestionPerRequirement, oneQuestionPerRequirement, // case-01
        new ProviderError("auth", "key rejected"), // case-03: model unavailable
        extraction, oneQuestionPerRequirement, oneQuestionPerRequirement, // case-05
      ]),
    ]);
    const cases = [
      goodCase,
      { id: "case-02", jd: "   ", company_url: "http://localhost:8099/x/", days: 3 },
      { ...goodCase, id: "case-03" },
      { id: "case-04", jd: JD, company_url: "http://localhost:8099/x/", days: 0 },
      { ...goodCase, id: "case-05", days: 9 },
      "not even an object",
    ];

    const output = await runBatch(cases, { llm, fetcher, now: NOW });

    expect(BatchOutputSchema.safeParse(output).success).toBe(true);
    expect(output.kits.map((k) => [k.id, k.status, k.error?.code ?? null])).toEqual([
      ["case-01", "ok", null],
      ["case-02", "failed", "JD_EMPTY"],
      ["case-03", "failed", "LLM_UNAVAILABLE"],
      ["case-04", "failed", "INVALID_INPUT"],
      ["case-05", "ok", null],
      ["case-6", "failed", "INVALID_INPUT"],
    ]);
    expect(output.kits[0]!.kit!.schedule.days).toHaveLength(3);
    expect(output.kits[4]!.kit!.schedule.days).toHaveLength(9);
  });

  it("returns a valid empty result for an empty case list", async () => {
    const output = await runBatch([], { llm: fakeLlmClient([fakeProvider([])]), fetcher, now: NOW });
    expect(output).toEqual({ version: "1.0", generated_at: "2026-09-19T12:00:00.000Z", kits: [] });
  });
});

describe("buildKit second pass", () => {
  const onlyFirstRequirement = (request: ProviderRequest) => {
    const first = /^(r\d+) \[/m.exec(request.prompt)![1]!;
    return { questions: [{ requirement_ids: [first], prompt: `Only ${first}`, answer_outline: "O", difficulty: 2 }] };
  };

  it("closes a gap the first draft left: the model is asked for the missed requirements only", async () => {
    // First technical call covers r1 only, leaving r2 (must) and r4 (nice) uncovered.
    const provider = fakeProvider([extraction, onlyFirstRequirement, oneQuestionPerRequirement, oneQuestionPerRequirement]);
    const kit = await buildKit(input, { llm: fakeLlmClient([provider]), fetcher, now: NOW });

    const gapCall = provider.requests[3]!;
    expect(gapCall.prompt).toContain("have no question yet");
    expect(gapCall.prompt).toContain("r2 [must]");
    expect(gapCall.prompt).not.toContain("r1 [must]");
    expect(kit.coverage).toEqual({ uncovered_requirement_ids: [], passes: 2 });
    expect(validateKit(kit)).toMatchObject({ ok: true });
  });

  it("writes the question itself when the model never covers a must-have", async () => {
    const nothing = { questions: [] };
    const provider = fakeProvider([extraction, onlyFirstRequirement, oneQuestionPerRequirement, nothing]);
    const kit = await buildKit(input, { llm: fakeLlmClient([provider]), fetcher, now: NOW });

    const fallback = kit.questions.filter((q) => q.origin === "fallback");
    expect(fallback.map((q) => q.requirement_ids)).toEqual([["r2"]]);
    expect(kit.coverage.uncovered_requirement_ids).toEqual(["r4"]);
    expect(kit.schedule.days.flatMap((d) => d.question_ids)).toContain(fallback[0]!.id);
    expect(kit.notes!.join(" ")).toContain("written by the application");
  });
});

describe("buildKit research", () => {
  const script = () => fakeLlmClient([fakeProvider([extraction, oneQuestionPerRequirement, oneQuestionPerRequirement])]);

  async function withFixtures<T>(run: (origin: string, pages: PageFetcher) => Promise<T>): Promise<T> {
    const { startFixtureServer } = await import("../fixtures/server");
    const { createPageFetcher } = await import("../src/retrieval/fetcher");
    const site = await startFixtureServer();
    const pages = createPageFetcher({ allowPrivate: true, localDelayMs: 0, retries: 0, timeoutMs: 2_000 });
    try {
      return await run(site.origin, pages);
    } finally {
      await pages.close();
      await site.close();
    }
  }

  it("records the pages it used, including a hiring page found by crawling", async () => {
    const kit = await withFixtures((origin, pages) =>
      buildKit({ ...input, companyUrl: `${origin}/acme/` }, { llm: script(), fetcher: pages, now: NOW }),
    );
    expect(kit.source.company).toBe("Acme Logistics");
    expect(kit.source.pages_used.map((url) => new URL(url).pathname)).toEqual([
      "/acme/",
      "/acme/about.html",
      "/acme/handbook/people/talent/stage-guide.html",
    ]);
    expect(kit.research_log).toContainEqual(expect.objectContaining({ source: "hiring-page", outcome: "used" }));
  });

  it("still returns a kit when the company address does not exist, and says what happened", async () => {
    const kit = await withFixtures((origin, pages) =>
      buildKit({ ...input, companyUrl: `${origin}/no-such-company/` }, { llm: script(), fetcher: pages, now: NOW }),
    );
    expect(kit.source.pages_used).toEqual([]);
    expect(kit.questions.length).toBeGreaterThan(0);
    expect(kit.notes!.join(" ")).toContain("based on the job description alone");
    expect(kit.research_log).toEqual([expect.objectContaining({ source: "company-site", outcome: "failed" })]);
  });

  it("says so when the site has no hiring page", async () => {
    const kit = await withFixtures((origin, pages) =>
      buildKit({ ...input, companyUrl: `${origin}/globex/` }, { llm: script(), fetcher: pages, now: NOW }),
    );
    expect(kit.notes!.join(" ")).toContain("does not publish how it hires");
    expect(kit.research_log).toContainEqual(expect.objectContaining({ source: "hiring-page", outcome: "empty" }));
  });
});
