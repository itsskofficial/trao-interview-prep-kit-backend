import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fingerprintOf } from "../src/jobs/runner";
import { ProviderError } from "../src/llm/types";
import { startTestApi, type TestApi } from "./support/api";
import { routedModel } from "./support/model";

const JD = "Senior Backend Engineer\n\nRequirements\n- 5+ years with Node.js\n- PostgreSQL";
const extraction = {
  title: "Senior Backend Engineer", seniority: "Senior", location: "", company: "", responsibilities: [],
  requirements: [
    { text: "5+ years with Node.js", evidence: "5+ years with Node.js", kind: "technical", priority: "must" },
    { text: "PostgreSQL", evidence: "PostgreSQL", kind: "technical", priority: "must" },
  ],
};
const newJob = { jd: JD, company_url: "https://acme.example/", days: 4 };

let api: TestApi;
let model: ReturnType<typeof routedModel>;
let failExtraction = false;

beforeAll(async () => {
  model = routedModel({ extract: () => { if (failExtraction) throw new ProviderError("auth", "key rejected"); return extraction; } });
  api = await startTestApi({}, { llm: model.llm });
}, 120_000);
afterAll(() => api.close());
beforeEach(async () => {
  failExtraction = false;
  await api.reset();
});

describe("starting generation", () => {
  it("answers at once with a queued job, then the job reports each step and ends with a kit", async () => {
    const ada = await api.signedIn();
    const started = await ada.post("/api/jobs").send(newJob).expect(202);
    expect(started.body).toMatchObject({ outcome: "started", job: { status: "queued", label: "Senior Backend Engineer", days: 4, kitId: null } });

    await api.runner.idle();
    const { job } = (await ada.get(`/api/jobs/${started.body.job.id}`).expect(200)).body;
    expect(job.status).toBe("succeeded");
    expect(job.steps.filter((s: { status: string }) => s.status !== "started").map((s: { step: string }) => s.step)).toEqual([
      "extract", "crawl", "discussion", "brief", "questions", "coverage", "flashcards", "schedule", "validate",
    ]);
    expect(job.steps).toContainEqual(expect.objectContaining({ step: "crawl", status: "failed", detail: "The site could not be reached." }));

    const kit = (await ada.get(`/api/kits/${job.kitId}`).expect(200)).body.kit;
    expect(kit.schedule.days).toHaveLength(4);
    expect(kit.notes.join(" ")).toContain("based on the job description alone");
  });

  it("names each invalid field", async () => {
    const ada = await api.signedIn();
    const response = await ada.post("/api/jobs").send({ jd: "  ", company_url: "acme.example", days: 0 }).expect(400);
    expect(response.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(["company_url", "days", "jd"]);
    expect(await api.db.jobs.countDocuments()).toBe(0);
  });

  it("requires a session", async () => {
    const { default: request } = await import("supertest");
    await request(api.app).post("/api/jobs").send(newJob).expect(401);
  });
});

describe("the same posting submitted twice", () => {
  it("returns the running job instead of starting a second one", async () => {
    const ada = await api.signedIn();
    const [first, second] = await Promise.all([ada.post("/api/jobs").send(newJob), ada.post("/api/jobs").send({ ...newJob, jd: `  ${JD}\n\n`, days: 9 })]);

    const outcomes = [first.body.outcome, second.body.outcome].sort();
    expect(outcomes).toEqual(["already_running", "started"]);
    expect(first.body.job.id).toBe(second.body.job.id);
    expect(await api.db.jobs.countDocuments()).toBe(1);
  });

  it("offers the existing kit once one exists, and generates again only when asked to", async () => {
    const ada = await api.signedIn();
    await ada.post("/api/jobs").send(newJob).expect(202);
    await api.runner.idle();
    const [kit] = (await ada.get("/api/kits")).body.kits;

    const again = await ada.post("/api/jobs").send(newJob).expect(200);
    expect(again.body).toEqual({ outcome: "kit_exists", kitId: kit.id });

    await ada.post("/api/jobs").send({ ...newJob, fresh: true }).expect(202);
    await api.runner.idle();
    expect((await ada.get("/api/kits")).body.kits).toHaveLength(2);
  });

  it("treats the same posting from two users as two kits", async () => {
    const [ada, bob] = [await api.signedIn(), await api.signedIn()];
    expect((await ada.post("/api/jobs").send(newJob)).body.outcome).toBe("started");
    expect((await bob.post("/api/jobs").send(newJob)).body.outcome).toBe("started");
  });

  it("ignores whitespace, letter case and a trailing slash, but not a different company", () => {
    expect(fingerprintOf(JD, "https://acme.example/")).toBe(fingerprintOf(`\n${JD.toUpperCase()}  `, "HTTPS://acme.example"));
    expect(fingerprintOf(JD, "https://acme.example/")).not.toBe(fingerprintOf(JD, "https://globex.example/"));
  });
});

describe("a job that fails", () => {
  it("stores a structured error and can be retried", async () => {
    const ada = await api.signedIn();
    failExtraction = true;
    const started = await ada.post("/api/jobs").send(newJob).expect(202);
    await api.runner.idle();

    const failed = (await ada.get(`/api/jobs/${started.body.job.id}`)).body.job;
    expect(failed).toMatchObject({ status: "failed", kitId: null, error: { code: "LLM_UNAVAILABLE" } });

    failExtraction = false;
    const retried = await ada.post(`/api/jobs/${failed.id}/retry`).expect(202);
    expect(retried.body.job).toMatchObject({ id: failed.id, status: "queued", steps: [], error: null });
    await api.runner.idle();
    expect((await ada.get(`/api/jobs/${failed.id}`)).body.job.status).toBe("succeeded");
  });

  it("refuses to retry a job that did not fail", async () => {
    const ada = await api.signedIn();
    const started = await ada.post("/api/jobs").send(newJob);
    await api.runner.idle();
    const response = await ada.post(`/api/jobs/${started.body.job.id}/retry`).expect(409);
    expect(response.body.error.code).toBe("NOT_RETRYABLE");
  });
});

describe("a server restart", () => {
  it("marks unfinished jobs as interrupted so they can be retried", async () => {
    const ada = await api.signedIn();
    const started = await ada.post("/api/jobs").send(newJob);
    await api.runner.idle();
    // Put the job back the way a process that died mid-run would have left it.
    await api.db.jobs.updateOne({}, { $set: { status: "running", active: true }, $unset: { kitId: "" } });
    await api.db.kits.deleteMany({});

    expect(await api.runner.recoverInterrupted()).toBe(1);

    const job = (await ada.get(`/api/jobs/${started.body.job.id}`)).body.job;
    expect(job).toMatchObject({ status: "interrupted", error: { code: "INTERNAL" } });
    await ada.post(`/api/jobs/${job.id}/retry`).expect(202);
    await api.runner.idle();
    expect((await ada.get(`/api/jobs/${job.id}`)).body.job.status).toBe("succeeded");
  });
});

describe("uploading several roles", () => {
  it("starts a job per valid case and reports the invalid ones beside them", async () => {
    const ada = await api.signedIn();
    const cases = [
      { id: "a", jd: JD, company_url: "https://acme.example/", days: 3 },
      { id: "b", jd: "", company_url: "nope", days: 3 },
      { id: "c", jd: `${JD}\n- Kubernetes`, company_url: "https://globex.example/", days: 7 },
      { id: "d", jd: JD, company_url: "https://acme.example/", days: 5 },
    ];
    const response = await ada.post("/api/jobs/batch").send({ cases }).expect(202);

    expect(response.body.results.map((r: { outcome: string }) => r.outcome)).toEqual(["started", "invalid", "started", "already_running"]);
    expect(response.body.results[1].issues.map((i: { field: string }) => i.field).sort()).toEqual(["company_url", "jd"]);
    await api.runner.idle();
    expect((await ada.get("/api/kits")).body.kits).toHaveLength(2);
    expect((await ada.get("/api/jobs")).body.jobs.every((job: { batchId: string }) => job.batchId === response.body.batchId)).toBe(true);
  });

  it("refuses an empty file and one with too many cases", async () => {
    const ada = await api.signedIn();
    await ada.post("/api/jobs/batch").send({ cases: [] }).expect(400);
    await ada.post("/api/jobs/batch").send({ cases: Array.from({ length: 11 }, () => newJob) }).expect(400);
  });
});

describe("job ownership", () => {
  it("hides a job from everyone but its owner", async () => {
    const [ada, bob] = [await api.signedIn(), await api.signedIn()];
    const started = await ada.post("/api/jobs").send(newJob);
    await bob.get(`/api/jobs/${started.body.job.id}`).expect(404);
    await bob.post(`/api/jobs/${started.body.job.id}/retry`).expect(404);
    expect((await bob.get("/api/jobs")).body.jobs).toEqual([]);
  });
});

describe("protecting the shared model quota", () => {
  it("refuses more generations than the hourly allowance, and says when to try again", async () => {
    const limited = await startTestApi({ GENERATIONS_PER_HOUR: 2 }, { llm: model.llm });
    try {
      const ada = await limited.signedIn();
      const post = (n: number) => ada.post("/api/jobs").send({ ...newJob, jd: `${JD}\n- Skill ${n}` });
      await post(1).expect(202);
      await post(2).expect(202);
      const refused = await post(3).expect(429);
      expect(refused.body.error.code).toBe("GENERATION_LIMIT");
      expect(refused.body.error.message).toMatch(/Try again in about \d+ minute/);

      // A duplicate costs nothing, so it is still answered.
      expect((await post(1)).body.outcome).toMatch(/already_running|kit_exists/);
      // Another account has its own allowance.
      const bob = await limited.signedIn();
      await bob.post("/api/jobs").send(newJob).expect(202);
    } finally {
      await limited.close();
    }
  }, 120_000);

  it("reports the cases of a file that went over the allowance instead of dropping them", async () => {
    const limited = await startTestApi({ GENERATIONS_PER_HOUR: 1 }, { llm: model.llm });
    try {
      const ada = await limited.signedIn();
      const cases = [1, 2].map((n) => ({ jd: `${JD}\n- Skill ${n}`, company_url: "https://acme.example/", days: 3 }));
      const { body } = await ada.post("/api/jobs/batch").send({ cases }).expect(202);
      expect(body.results.map((r: { outcome: string }) => r.outcome)).toEqual(["started", "limited"]);
    } finally {
      await limited.close();
    }
  }, 120_000);

  it("limits how many kits one account can have generating at once", async () => {
    const limited = await startTestApi({ MAX_ACTIVE_JOBS: 1 });
    try {
      const ada = await limited.signedIn();
      await ada.post("/api/jobs").send(newJob).expect(202);
      await limited.db.jobs.updateMany({}, { $set: { active: true, status: "running" } });
      const refused = await ada.post("/api/jobs").send({ ...newJob, jd: `${JD}\n- Other` }).expect(429);
      expect(refused.body.error.code).toBe("TOO_MANY_ACTIVE_JOBS");
    } finally {
      await limited.close();
    }
  }, 120_000);
});

describe("exporting a kit", () => {
  it("downloads the kit alone, in the Appendix A structure", async () => {
    const { validateKit } = await import("../src/kit/validate");
    const ada = await api.signedIn();
    await ada.post("/api/jobs").send(newJob).expect(202);
    await api.runner.idle();
    const [kit] = (await ada.get("/api/kits")).body.kits;

    const response = await ada.get(`/api/kits/${kit.id}/export`).expect(200);
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="kit-.*\.json"$/);
    expect(validateKit(JSON.parse(response.text))).toMatchObject({ ok: true });
    expect(Object.keys(JSON.parse(response.text))).toEqual(expect.arrayContaining(["source", "company_brief", "role", "questions", "flashcards", "schedule", "coverage"]));

    const bob = await api.signedIn();
    await bob.get(`/api/kits/${kit.id}/export`).expect(404);
  });
});

describe("run trace", () => {
  it("is stored with the job and the kit, returned on request, and left out of lists", async () => {
    const ada = await api.signedIn();
    const started = await ada.post("/api/jobs").send(newJob).expect(202);
    await api.runner.idle();

    const { job } = (await ada.get(`/api/jobs/${started.body.job.id}`).expect(200)).body;
    expect(job.trace).toMatchObject({ outcome: "ok", totals: { models: ["routed-fake"] } });
    expect(job.trace.steps.map((step: { step: string }) => step.step)).toContain("coverage");

    const listed = (await ada.get("/api/jobs").expect(200)).body.jobs[0];
    expect(listed).not.toHaveProperty("trace");

    const { trace } = (await ada.get(`/api/kits/${job.kitId}/trace`).expect(200)).body;
    expect(trace.totals.llmCalls).toBe(job.trace.totals.llmCalls);
    expect((await ada.get(`/api/kits/${job.kitId}`).expect(200)).body).not.toHaveProperty("trace");
  });

  it("keeps the trace of a failed run, and clears it on retry", async () => {
    const ada = await api.signedIn();
    failExtraction = true;
    const started = await ada.post("/api/jobs").send(newJob).expect(202);
    await api.runner.idle();

    const failed = (await ada.get(`/api/jobs/${started.body.job.id}`).expect(200)).body.job;
    expect(failed.trace).toMatchObject({ outcome: "failed", steps: [{ step: "extract", status: "failed" }] });
    expect(failed.trace.llmCalls[0]).toMatchObject({ outcome: "auth", error: "key rejected" });

    failExtraction = false;
    await ada.post(`/api/jobs/${started.body.job.id}/retry`).expect(202);
    await api.runner.idle();
    expect((await ada.get(`/api/jobs/${started.body.job.id}`).expect(200)).body.job.trace).toMatchObject({ outcome: "ok" });
  });

  it("belongs to the kit's owner only, and is null for a kit made before tracing", async () => {
    const ada = await api.signedIn();
    const started = await ada.post("/api/jobs").send(newJob).expect(202);
    await api.runner.idle();
    const { kitId } = (await ada.get(`/api/jobs/${started.body.job.id}`).expect(200)).body.job;

    const grace = await api.signedIn();
    await grace.get(`/api/kits/${kitId}/trace`).expect(404);

    await api.db.kits.updateMany({}, { $unset: { trace: "" } });
    expect((await ada.get(`/api/kits/${kitId}/trace`).expect(200)).body).toEqual({ trace: null });
  });
});
