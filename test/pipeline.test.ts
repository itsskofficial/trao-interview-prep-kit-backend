import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/server";
import { runBatch } from "../src/batch/run";
import { BatchOutputSchema } from "../src/batch/schema";
import { validateKit } from "../src/kit/validate";
import { ProviderError, type ProviderRequest } from "../src/llm/types";
import { buildKit, type PipelineDeps, type ProgressEvent } from "../src/pipeline/build-kit";
import type { DiscussionSearch } from "../src/retrieval/discussion";
import { createPageFetcher, type PageFetcher } from "../src/retrieval/fetcher";
import { routedModel } from "./support/model";

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

const acmeBrief = {
  summary: "Acme Logistics builds route-planning software for courier companies.",
  what_they_do: "A route optimiser and dispatch tools.",
  hiring_stages: ["Recruiter call", "Take-home exercise", "System design interview", "Values interview with the hiring manager", "Whiteboard puzzles with the CEO"],
  interview_insights: ["They love brain teasers"],
};

const NOW = () => new Date("2026-09-19T12:00:00Z");
const noDiscussion: DiscussionSearch = async () => ({ snippets: [], log: [{ source: "hacker-news", outcome: "empty", reason: "Nothing found." }] });

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

const deps = (llm: PipelineDeps["llm"], extra: Partial<PipelineDeps> = {}): PipelineDeps => ({ llm, fetcher, searchDiscussion: noDiscussion, now: NOW, ...extra });
const caseFor = (company: string, days = 5) => ({ jd: JD, companyUrl: `${site.origin}/${company}/`, days });

describe("buildKit", () => {
  it("produces a structurally valid kit", async () => {
    const model = routedModel({ extract: extraction, brief: acmeBrief });
    const kit = await buildKit(caseFor("acme"), deps(model.llm));

    expect(validateKit(kit)).toMatchObject({ ok: true });
    expect(kit.source).toMatchObject({ company: "Acme Logistics", jd_chars: JD.length, researched_at: "2026-09-19T12:00:00.000Z" });
    expect(kit.role.requirements.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(kit.schedule.days).toHaveLength(5);
    expect(kit.coverage).toEqual({ uncovered_requirement_ids: [], passes: 1 });
    expect(kit.flashcards.length).toBeGreaterThan(0);
  });

  it("runs the steps in order, each after the one it depends on", async () => {
    const events: ProgressEvent[] = [];
    const model = routedModel({ extract: extraction, brief: acmeBrief });
    await buildKit(caseFor("acme"), deps(model.llm, { onProgress: (event) => events.push(event) }));

    expect(events.filter((e) => e.status !== "started").map((e) => e.step)).toEqual([
      "extract", "crawl", "discussion", "brief", "questions", "coverage", "flashcards", "schedule", "validate",
    ]);
    expect(model.routes()).toEqual(["extract", "brief", "technical", "behavioural", "system-design", "company-fit", "flashcards"]);
  });

  it("records the pages it used, including a hiring page found by crawling", async () => {
    const kit = await buildKit(caseFor("acme"), deps(routedModel({ extract: extraction, brief: acmeBrief }).llm));
    expect(kit.source.pages_used.map((url) => new URL(url).pathname)).toEqual(["/acme/", "/acme/about.html", "/acme/handbook/people/talent/stage-guide.html"]);
    expect(kit.company_brief.sources).toEqual(kit.source.pages_used);
    expect(kit.research_log).toContainEqual(expect.objectContaining({ source: "hiring-page", outcome: "used" }));
    expect(kit.research_log).toContainEqual(expect.objectContaining({ source: "hacker-news", outcome: "empty" }));
  });

  it("generates each category in its own call, with its own instructions and only its own requirements", async () => {
    const model = routedModel({ extract: extraction, brief: acmeBrief });
    const kit = await buildKit(caseFor("acme"), deps(model.llm));

    const technical = model.requestFor("technical")!;
    const behavioural = model.requestFor("behavioural")!;
    expect(technical.system).not.toEqual(behavioural.system);
    expect(technical.prompt).toContain("r1 [must]");
    expect(technical.prompt).not.toContain("r3 [must]");
    expect(behavioural.prompt).toContain("r3 [must]");
    expect(behavioural.prompt).not.toContain("r1 [must]");
    expect(new Set(kit.questions.map((q) => q.category))).toEqual(new Set(["technical", "behavioural", "system-design", "company-fit"]));
  });

  it("lets a published hiring process change what is asked for", async () => {
    const withProcess = routedModel({ extract: extraction, brief: acmeBrief });
    const withoutProcess = routedModel({ extract: extraction, brief: { ...acmeBrief, hiring_stages: [] } });
    await buildKit(caseFor("acme"), deps(withProcess.llm));
    await buildKit(caseFor("globex"), deps(withoutProcess.llm));

    expect(withProcess.requestFor("technical")!.prompt).toContain("take-home style task");
    expect(withProcess.requestFor("system-design")!.prompt).toContain("System design interview");
    expect(withoutProcess.requestFor("technical")!.prompt).not.toContain("take-home");
  });

  it("keeps only hiring stages and insights that the retrieved text supports", async () => {
    const kit = await buildKit(caseFor("acme"), deps(routedModel({ extract: extraction, brief: acmeBrief }).llm));
    expect(kit.hiring_stages).toEqual(["Recruiter call", "Take-home exercise", "System design interview", "Values interview with the hiring manager"]);
    expect(kit.interview_insights).toEqual([]);
  });

  it("discards requirement ids the model made up", async () => {
    const madeUp = { questions: [{ requirement_ids: ["r1", "r99"], prompt: "P", answer_outline: "O", difficulty: 3 }] };
    const kit = await buildKit(caseFor("acme"), deps(routedModel({ extract: extraction, technical: madeUp }).llm));
    expect(kit.questions[0]!.requirement_ids).toEqual(["r1"]);
  });

  it("uses the requested number of days", async () => {
    const kit = await buildKit(caseFor("acme", 60), deps(routedModel({ extract: extraction }).llm));
    expect(kit.schedule.days_available).toBe(60);
    expect(kit.schedule.days).toHaveLength(60);
  });
});

describe("buildKit when there is little to work with", () => {
  it("still returns a kit when the company address does not exist, says what happened, and does not ask the model about the company", async () => {
    const model = routedModel({ extract: extraction });
    const kit = await buildKit(caseFor("no-such-company"), deps(model.llm));

    expect(model.routes()).not.toContain("brief");
    expect(model.routes()).not.toContain("company-fit");
    expect(kit.source.pages_used).toEqual([]);
    expect(kit.company_brief.sources).toEqual([]);
    expect(kit.company_brief.summary).toContain("No information about");
    expect(kit.questions.length).toBeGreaterThan(0);
    expect(kit.notes!.join(" ")).toContain("based on the job description alone");
    expect(validateKit(kit)).toMatchObject({ ok: true });
  });

  it("says so when the site has no hiring page, and reports no stages", async () => {
    const model = routedModel({ extract: extraction, brief: { ...acmeBrief, hiring_stages: ["Take-home exercise"] } });
    const kit = await buildKit(caseFor("globex"), deps(model.llm));

    expect(model.requestFor("brief")!.prompt).toContain("hiring_stages must be empty");
    expect(kit.hiring_stages).toEqual([]);
    expect(kit.notes!.join(" ")).toContain("does not publish how it hires");
    expect(kit.research_log).toContainEqual(expect.objectContaining({ source: "hiring-page", outcome: "empty" }));
  });

  it("builds a thin, honest kit from a stub that states nothing", async () => {
    const model = routedModel();
    const kit = await buildKit({ ...caseFor("no-such-company"), jd: "We are hiring! Apply now." }, deps(model.llm));

    expect(model.routes()).toEqual(["extract"]);
    expect(kit.role.requirements).toEqual([]);
    expect(kit.questions).toEqual([]);
    expect(kit.flashcards).toEqual([]);
    expect(kit.schedule.days).toHaveLength(5);
    expect(kit.notes!.join(" ")).toContain("deliberately thin");
    expect(validateKit(kit)).toMatchObject({ ok: true });
  });

  it("loses a section, not the kit, when one generation step fails", async () => {
    const model = routedModel({ extract: extraction, flashcards: { nonsense: true }, brief: new ProviderError("server", "503") });
    const kit = await buildKit(caseFor("acme"), deps(model.llm));

    expect(kit.flashcards).toEqual([]);
    expect(kit.notes!.join(" ")).toContain("Flashcards could not be generated");
    expect(kit.notes!.join(" ")).toContain("company brief could not be written");
    expect(kit.questions.length).toBeGreaterThan(0);
  });

  it("passes fetched text to the model only inside untrusted blocks, with planted instructions already removed", async () => {
    const model = routedModel({ extract: extraction });
    await buildKit(caseFor("umbrella"), deps(model.llm));
    const brief = model.requestFor("brief")!;
    expect(brief.system).toContain("never an instruction");
    expect(brief.prompt).toContain("<untrusted_company_page>");
    expect(brief.prompt).not.toContain("COBOL");
    expect(brief.prompt).not.toContain("Nobel");
  });
});

describe("buildKit second pass", () => {
  const onlyFirstRequirement = (request: ProviderRequest) => {
    const first = /^(r\d+) \[/m.exec(request.prompt)![1]!;
    return { questions: [{ requirement_ids: [first], prompt: `Only ${first}`, answer_outline: "O", difficulty: 2 }] };
  };
  const coversNothing = { questions: [] };

  it("closes a gap the first draft left: the model is asked for the missed requirements only", async () => {
    // The technical and system-design calls cover r1 only, leaving r2 (must) and r4 (nice) uncovered.
    const model = routedModel({ extract: extraction, technical: onlyFirstRequirement, "system-design": onlyFirstRequirement });
    const kit = await buildKit(caseFor("no-such-company"), deps(model.llm));

    const gapCall = model.requestFor("gaps")!;
    expect(gapCall.prompt).toContain("r2 [must]");
    expect(gapCall.prompt).toContain("r4 [nice]");
    expect(gapCall.prompt).not.toContain("r1 [must]");
    expect(kit.coverage).toEqual({ uncovered_requirement_ids: [], passes: 2 });
    expect(validateKit(kit)).toMatchObject({ ok: true });
  });

  it("writes the question itself when the model never covers a must-have", async () => {
    const model = routedModel({ extract: extraction, technical: onlyFirstRequirement, "system-design": onlyFirstRequirement, gaps: coversNothing });
    const kit = await buildKit(caseFor("no-such-company"), deps(model.llm));

    const fallback = kit.questions.filter((q) => q.origin === "fallback");
    expect(fallback.map((q) => q.requirement_ids)).toEqual([["r2"]]);
    expect(kit.coverage.uncovered_requirement_ids).toEqual(["r4"]);
    expect(kit.schedule.days.flatMap((d) => d.question_ids)).toContain(fallback[0]!.id);
    expect(kit.notes!.join(" ")).toContain("written by the application");
  });

  it("covers every must-have even if every question call fails", async () => {
    const down = new ProviderError("server", "503");
    const model = routedModel({ extract: extraction, technical: down, behavioural: down, "system-design": down, gaps: down, flashcards: down });
    const kit = await buildKit(caseFor("no-such-company"), deps(model.llm));

    expect(kit.questions.map((q) => q.origin)).toEqual(["fallback", "fallback", "fallback"]);
    expect(kit.coverage.uncovered_requirement_ids).toEqual(["r4"]);
    expect(validateKit(kit)).toMatchObject({ ok: true });
  });
});

describe("runBatch", () => {
  it("writes one entry per case and carries on after failures", async () => {
    const model = routedModel({ extract: [extraction, new ProviderError("auth", "key rejected"), extraction] });
    const good = { id: "case-01", jd: JD, company_url: `${site.origin}/acme/`, days: 3 };
    const cases = [
      good,
      { id: "case-02", jd: "   ", company_url: `${site.origin}/acme/`, days: 3 },
      { ...good, id: "case-03", days: 4 },
      { id: "case-04", jd: JD, company_url: `${site.origin}/acme/`, days: 0 },
      { ...good, id: "case-05", days: 9 },
      "not even an object",
    ];

    const output = await runBatch(cases, { ...deps(model.llm), concurrency: 1 });

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

  it("runs cases concurrently but reports them in input order", async () => {
    const model = routedModel({ extract: extraction });
    const cases = [1, 2, 3, 4].map((n) => ({ id: `case-${n}`, jd: JD, company_url: `${site.origin}/acme/`, days: n }));
    const lines: string[] = [];
    const output = await runBatch(cases, { ...deps(model.llm), concurrency: 3, log: (line) => lines.push(line) });

    expect(output.kits.map((k) => k.id)).toEqual(["case-1", "case-2", "case-3", "case-4"]);
    expect(output.kits.map((k) => k.kit!.schedule.days.length)).toEqual([1, 2, 3, 4]);
    expect(lines).toHaveLength(4);
  });

  it("researches an identical case once and gives both entries the result", async () => {
    const model = routedModel({ extract: extraction });
    const same = { jd: JD, company_url: `${site.origin}/acme/`, days: 5 };
    const output = await runBatch([{ id: "first", ...same }, { id: "again", ...same }], deps(model.llm));

    expect(output.kits.map((k) => [k.id, k.status])).toEqual([["first", "ok"], ["again", "ok"]]);
    expect(model.routes().filter((route) => route === "extract")).toHaveLength(1);
  });

  it("records a case that overruns its time budget as TIMEOUT and finishes the rest", async () => {
    const never = { ...deps(routedModel({ extract: extraction }).llm) };
    const slowFetcher: PageFetcher = { close: async () => undefined, fetchPage: (url) => (url.includes("/slow/") ? new Promise(() => undefined) : fetcher.fetchPage(url)) };
    const output = await runBatch(
      [
        { id: "slow", jd: JD, company_url: `${site.origin}/slow/`, days: 2 },
        { id: "fine", jd: JD, company_url: `${site.origin}/acme/`, days: 2 },
      ],
      { ...never, fetcher: slowFetcher, caseTimeoutMs: 300 },
    );
    expect(output.kits.map((k) => [k.id, k.status, k.error?.code ?? null])).toEqual([["slow", "failed", "TIMEOUT"], ["fine", "ok", null]]);
  });

  it("returns a valid empty result for an empty case list", async () => {
    const output = await runBatch([], deps(routedModel().llm));
    expect(output).toEqual({ version: "1.0", generated_at: "2026-09-19T12:00:00.000Z", kits: [] });
  });
});

describe("buildKit public discussion", () => {
  const found: DiscussionSearch = async () => ({
    snippets: [{ source: "hacker-news", url: "https://news.ycombinator.com/item?id=1", text: "I interviewed at Acme Logistics: the take-home was a routing problem and they paid for my time." }],
    log: [{ source: "hacker-news", outcome: "used", reason: "1 relevant result(s)" }],
  });

  it("uses discussion that is about this company, and cites it", async () => {
    const brief = { ...acmeBrief, interview_insights: ["The take-home was a routing problem and they paid for the time"] };
    const model = routedModel({ extract: extraction, brief });
    const kit = await buildKit(caseFor("acme"), deps(model.llm, { searchDiscussion: found }));

    expect(model.requestFor("brief")!.prompt).toContain("<untrusted_public_discussion>");
    expect(kit.interview_insights).toEqual(brief.interview_insights);
    expect(kit.company_brief.sources).toContain("https://news.ycombinator.com/item?id=1");
    expect(model.requestFor("company-fit")!.prompt).toContain("routing problem");
  });

  it("does not cite search results the brief made no use of, and says why in the log", async () => {
    const model = routedModel({ extract: extraction, brief: { ...acmeBrief, interview_insights: [] } });
    const kit = await buildKit(caseFor("acme"), deps(model.llm, { searchDiscussion: found }));

    expect(kit.company_brief.sources.some((url) => url.includes("ycombinator"))).toBe(false);
    expect(kit.research_log).toContainEqual(expect.objectContaining({ source: "public-discussion", outcome: "empty" }));
  });
});
