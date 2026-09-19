import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import type { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runBatch } from "../src/batch/run";
import { BatchOutputSchema, CaseInputSchema } from "../src/batch/schema";
import { reconcile } from "../src/builder/operations";
import { kitRepository } from "../src/persistence/kits";
import { buildKit } from "../src/pipeline/build-kit";
import type { PageFetcher } from "../src/retrieval/fetcher";
import { startTestApi, type TestApi } from "./support/api";
import { appendixAKit } from "./support/kits";
import { routedModel } from "./support/model";

/** One test per defect a code review found, so none of them comes back quietly. */

const JD = "Backend Engineer\n\nRequirements\n- Node.js\n- PostgreSQL";
const extraction = {
  title: "Backend Engineer", seniority: "", location: "", company: "", responsibilities: [],
  requirements: [
    { text: "Node.js", evidence: "Node.js", kind: "technical", priority: "must" },
    { text: "PostgreSQL", evidence: "PostgreSQL", kind: "technical", priority: "must" },
  ],
};
const unreachable: PageFetcher = { close: async () => undefined, fetchPage: async (url) => ({ ok: false, url, reason: "network", detail: "down" }) };
const noDiscussion = async () => ({ snippets: [], log: [] });

describe("the batch input is read forgivingly", () => {
  it("accepts a numeric id and days given as a string, and keys the result by that id", () => {
    expect(CaseInputSchema.parse({ id: 7, jd: "x", company_url: "acme.com", days: "5" })).toEqual({ id: "7", jd: "x", company_url: "acme.com", days: 5 });
    expect(CaseInputSchema.safeParse({ id: "a", jd: "x", company_url: "u", days: "five" }).success).toBe(false);
  });

  it("keeps the grader's id on a failed case even when the id is a number", async () => {
    const output = await runBatch([{ id: 42, jd: "  ", company_url: "x", days: 3 }], { llm: routedModel().llm, fetcher: unreachable });
    expect(output.kits[0]).toMatchObject({ id: "42", status: "failed", error: { code: "JD_EMPTY" } });
  });

  it("accepts a company address typed without a scheme, and records it as given", async () => {
    const fetched: string[] = [];
    const fetcher: PageFetcher = { close: async () => undefined, fetchPage: async (url) => (fetched.push(url), { ok: false, url, reason: "network", detail: "down" }) };
    const kit = await buildKit({ jd: JD, companyUrl: "acme.example/careers", days: 2 }, { llm: routedModel({ extract: extraction }).llm, fetcher, searchDiscussion: noDiscussion });
    expect(fetched[0]).toBe("http://acme.example/careers");
    expect(kit.source.company_url).toBe("acme.example/careers");
  });

  it("reads a cases file that starts with a byte-order mark, and writes the output file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evaluate-"));
    const input = path.join(dir, "cases.json");
    const output = path.join(dir, "out", "kits.json");
    await writeFile(input, `﻿${JSON.stringify([{ id: "bom", jd: JD, company_url: "http://127.0.0.1:9/", days: 2 }])}`, "utf8");

    await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli/evaluate.ts", "--input", input, "--output", output], {
      env: { ...process.env, LLM_PROVIDER: "offline", NODE_ENV: "test" },
    });

    const written = BatchOutputSchema.parse(JSON.parse(await readFile(output, "utf8")));
    expect(written.kits.map((kit) => [kit.id, kit.status])).toEqual([["bom", "ok"]]);
  }, 60_000);
});

describe("a case past its time budget", () => {
  it("stops spending model calls once it has been given up on", async () => {
    const model = routedModel({ extract: extraction });
    let release: () => void = () => undefined;
    // The crawl hangs, the case times out, and only then does the site answer.
    const slow: PageFetcher = { close: async () => undefined, fetchPage: (url) => new Promise((resolve) => (release = () => resolve({ ok: false, url, reason: "network", detail: "late" }))) };

    const output = await runBatch([{ id: "slow", jd: JD, company_url: "http://slow.example/", days: 2 }], { llm: model.llm, fetcher: slow, searchDiscussion: noDiscussion, caseTimeoutMs: 100 });
    expect(output.kits[0]).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });

    const callsAtTimeout = model.requests.length;
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(model.requests.length).toBe(callsAtTimeout);
  });

  it("reports each finished case as it goes, so a run stopped early still has a file", async () => {
    const partials: number[] = [];
    await runBatch(
      [1, 2, 3].map((n) => ({ id: `c${n}`, jd: `${JD}\n- Skill ${n}`, company_url: "http://x.example/", days: 2 })),
      { llm: routedModel({ extract: extraction }).llm, fetcher: unreachable, searchDiscussion: noDiscussion, concurrency: 1, onPartial: (finished) => void partials.push(finished.length) },
    );
    expect(partials).toEqual([1, 2, 3]);
  });
});

describe("research steps cannot fail a kit", () => {
  it("treats an exception while crawling or searching as missing research", async () => {
    const exploding: PageFetcher = { close: async () => undefined, fetchPage: async () => { throw new TypeError("Invalid URL"); } };
    const kit = await buildKit(
      { jd: JD, companyUrl: "http://acme.example/", days: 2 },
      { llm: routedModel({ extract: extraction }).llm, fetcher: exploding, searchDiscussion: async () => { throw new Error("search exploded"); } },
    );
    expect(kit.questions.length).toBeGreaterThan(0);
    expect(kit.research_log).toContainEqual(expect.objectContaining({ source: "company-site", outcome: "failed" }));
    expect(kit.research_log).toContainEqual(expect.objectContaining({ source: "public-discussion", outcome: "skipped" }));
  });
});

describe("the hourly allowance", () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startTestApi({ GENERATIONS_PER_HOUR: 3 });
  }, 120_000);
  afterAll(() => api.close());
  beforeEach(() => api.reset());

  it("holds when many requests arrive at the same instant", async () => {
    // One real listening server: supertest otherwise opens a throwaway server per request, and a dozen
    // of those at once get their connections reset on a busy CI runner.
    const server = api.app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      const registered = await fetch(`${origin}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "burst@example.com", password: "correct horse battery" }),
      });
      const cookie = registered.headers.get("set-cookie")!.split(";")[0]!;

      const statuses = await Promise.all(
        Array.from({ length: 12 }, (_, n) =>
          fetch(`${origin}/api/jobs`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ jd: `${JD}\n- Skill ${n}`, company_url: "https://acme.example/", days: 3 }),
          }).then((response) => response.status),
        ),
      );
      expect(statuses.filter((status) => status === 202).length).toBeLessThanOrEqual(3);
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(9);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("gives the charge back when a regeneration is refused", async () => {
    const ada = await api.signedIn("ada@example.com");
    const userId = (await api.db.users.findOne({ email: "ada@example.com" }))!._id as ObjectId;
    const kit = reconcile({ ...appendixAKit(), company_brief: { ...appendixAKit().company_brief, edited: true } });
    const stored = await kitRepository(api.db).create(userId, kit, "fp");

    // Refused three times over: a protected brief that has not been confirmed.
    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await ada.post(`/api/kits/${stored.id}/regenerate`).send({ section: "brief" })).body.error.code).toBe("BRIEF_PROTECTED");
    }
    expect(await api.db.usage.countDocuments()).toBe(0);
    await ada.post("/api/kits/000000000000000000000000/regenerate").send({ section: "brief" }).expect(404);
    expect(await api.db.usage.countDocuments()).toBe(0);
  });

  it("charges a retry like a generation", async () => {
    const ada = await api.signedIn();
    const started = await ada.post("/api/jobs").send({ jd: JD, company_url: "https://acme.example/", days: 3 }).expect(202);
    await api.runner.idle();
    await api.db.jobs.updateOne({}, { $set: { status: "failed" }, $unset: { active: "", kitId: "" } });
    await ada.post(`/api/jobs/${started.body.job.id}/retry`).expect(202);
    expect(await api.db.usage.countDocuments()).toBe(2);
  });
});

describe("a forced brief regeneration", () => {
  it("still keeps text the user typed while it was running", async () => {
    let release: () => void = () => undefined;
    let crawlStarted: () => void = () => undefined;
    const crawling = new Promise<void>((resolve) => (crawlStarted = resolve));
    const held: PageFetcher & { calls: number } = {
      close: async () => undefined,
      // Only the first request (the company's homepage) is held back; the searches that follow answer at once.
      fetchPage: (url) =>
        new Promise((resolve) => {
          const answer = () => resolve({ ok: false, url, reason: "network", detail: "down" });
          if (held.calls++ > 0) return answer();
          release = answer;
          crawlStarted();
        }),
      calls: 0,
    } as PageFetcher & { calls: number };
    const api = await startTestApi({}, { fetcher: held });
    try {
      const ada = await api.signedIn("ada@example.com");
      const userId = (await api.db.users.findOne({ email: "ada@example.com" }))!._id as ObjectId;
      const stored = await kitRepository(api.db).create(userId, reconcile(appendixAKit()), "fp");
      const base = `/api/kits/${stored.id}`;

      await ada.patch(`${base}/brief`).send({ summary: "My first version" }).expect(200);
      await ada.post(`${base}/regenerate`).send({ section: "brief", force: true }).expect(202);
      await crawling; // the regeneration is now genuinely in flight
      await ada.patch(`${base}/brief`).send({ summary: "Corrected while it was running" }).expect(200);
      release();
      await api.regenerator.idle();

      const after = (await ada.get(base)).body;
      expect(after.kit.company_brief.summary).toBe("Corrected while it was running");
      expect(after.regeneration).toMatchObject({ status: "failed", error: expect.stringContaining("your version was kept") });
    } finally {
      release();
      await api.close();
    }
  }, 120_000);
});
