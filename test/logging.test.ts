import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/api/app";
import { createJobRunner } from "../src/jobs/runner";
import { createLogger } from "../src/logging/logger";
import { ProviderError } from "../src/llm/types";
import { startTestApi, type TestApi } from "./support/api";
import { routedModel } from "./support/model";

/** A destination that keeps what was written, parsed, so a test can read the log the way a log viewer would. */
function capture() {
  const lines: Array<Record<string, unknown>> = [];
  return { lines, stream: { write: (line: string) => void lines.push(JSON.parse(line)) } };
}

const JD = "Backend Engineer\n\nRequirements\n- PostgreSQL";
const extraction = { title: "Backend Engineer", seniority: "", location: "", company: "", responsibilities: [], requirements: [{ text: "PostgreSQL", evidence: "PostgreSQL", kind: "technical", priority: "must" }] };

describe("logger", () => {
  it("writes JSON lines with a level name and an ISO time", () => {
    const { lines, stream } = capture();
    createLogger("info", stream).info({ jobId: "j1" }, "job started");
    expect(lines).toEqual([{ level: "info", time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), jobId: "j1", msg: "job started" }]);
  });

  it("censors secrets however deep they are, should anyone ever log an object that has them", () => {
    const { lines, stream } = capture();
    createLogger("info", stream).info({
      password: "hunter2",
      user: { passwordHash: "$2a$...", email: "ada@example.com" },
      req: { headers: { cookie: "session=abc", authorization: "Bearer x", "set-cookie": "session=abc" } },
      config: { apiKey: "AIza-something" },
    });
    const written = JSON.stringify(lines);
    for (const secret of ["hunter2", "$2a$", "session=abc", "Bearer x", "AIza"]) expect(written).not.toContain(secret);
    expect(written).toContain("ada@example.com");
  });

  it("censors at any depth, inside arrays, and survives an object that contains itself", () => {
    const { lines, stream } = capture();
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    createLogger("info", stream).info({ a: { b: { c: { d: { e: { token: "deep-secret" } } } } }, list: [{ apiKey: "in-a-list" }], loop, err: new Error("kept") });
    const written = JSON.stringify(lines);
    expect(written).not.toContain("deep-secret");
    expect(written).not.toContain("in-a-list");
    expect(written).toContain("[redacted]");
    expect(lines[0]).toMatchObject({ loop: { name: "loop", self: "[omitted]" }, err: { message: "kept" } });
  });

  it("says nothing below its level", () => {
    const { lines, stream } = capture();
    const logger = createLogger("warn", stream);
    logger.info("quiet");
    logger.warn("loud");
    expect(lines.map((line) => line.msg)).toEqual(["loud"]);
  });
});

describe("request and job logging", () => {
  let api: TestApi;
  const log = capture();
  let fail = false;

  beforeAll(async () => {
    const model = routedModel({ extract: () => { if (fail) throw new ProviderError("auth", "key rejected"); return extraction; } });
    api = await startTestApi({}, { llm: model.llm });
    const logger = createLogger("debug", log.stream);
    // The same database and configuration, with a logger that can be read.
    api.runner = createJobRunner(api.db, { llm: model.llm, fetcher: { fetchPage: async (url) => ({ ok: false, url, reason: "network", detail: "" }), close: async () => undefined } }, { logger });
    api.app = createApp({ db: api.db, config: api.config, runner: api.runner, regenerator: api.regenerator, logger });
  }, 120_000);
  afterAll(() => api.close());

  const signIn = async () => {
    const agent = request.agent(api.app);
    await agent.post("/api/auth/register").send({ email: `log${Date.now()}${Math.random()}@example.com`, password: "correct horse battery" }).expect(201);
    return agent;
  };

  it("logs one line per request with an id that is also returned to the caller, and no body or query", async () => {
    log.lines.length = 0;
    const response = await request(api.app).post("/api/auth/login?next=/secret-page").send({ email: "nobody@example.com", password: "a-password-that-must-not-be-logged" });

    const line = log.lines.find((entry) => entry.msg === "request")!;
    expect(line).toMatchObject({ level: "info", method: "POST", path: "/api/auth/login", status: 401, ms: expect.any(Number) });
    expect(response.headers["x-request-id"]).toBe(line.requestId);
    expect(JSON.stringify(log.lines)).not.toMatch(/must-not-be-logged|secret-page|nobody@example/);
  });

  it("says who asked once they are signed in", async () => {
    const ada = await signIn();
    log.lines.length = 0;
    await ada.get("/api/kits").expect(200);
    expect(log.lines.find((entry) => entry.msg === "request")).toMatchObject({ path: "/api/kits", userId: expect.stringMatching(/^[0-9a-f]{24}$/) });
  });

  it("keeps a caller's request id only when it is plainly an id", async () => {
    const kept = await request(api.app).get("/api/health").set("X-Request-Id", "edge-7f3a9c21");
    expect(kept.headers["x-request-id"]).toBe("edge-7f3a9c21");
    const replaced = await request(api.app).get("/api/health").set("X-Request-Id", 'x"} {"level":"error","msg":"forged');
    expect(replaced.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs health checks at debug only", async () => {
    log.lines.length = 0;
    await request(api.app).get("/api/health").expect(200);
    expect(log.lines.find((entry) => entry.msg === "request")).toMatchObject({ level: "debug" });
  });

  it("puts the job id on every line of a job, and the run's totals on the last", async () => {
    const ada = await signIn();
    log.lines.length = 0;
    const started = await ada.post("/api/jobs").send({ jd: JD, company_url: "https://acme.example/", days: 2 }).expect(202);
    await api.runner.idle();

    const jobLines = log.lines.filter((entry) => entry.jobId === started.body.job.id);
    expect(jobLines[0]).toMatchObject({ level: "info", msg: "job started", days: 2 });
    expect(jobLines.at(-1)).toMatchObject({ level: "info", msg: "job succeeded", llmCalls: expect.any(Number), models: ["routed-fake"] });
    expect(jobLines.some((entry) => entry.msg === "step failed" && entry.step === "crawl")).toBe(true);
    expect(JSON.stringify(jobLines)).not.toContain("PostgreSQL");
  });

  it("logs a job that could not produce a kit as a warning with its error code", async () => {
    const ada = await signIn();
    fail = true;
    log.lines.length = 0;
    const started = await ada.post("/api/jobs").send({ jd: `${JD} `, company_url: "https://other.example/", days: 2 }).expect(202);
    await api.runner.idle();
    fail = false;

    expect(log.lines.find((entry) => entry.msg === "job failed")).toMatchObject({ level: "warn", jobId: started.body.job.id, code: "LLM_UNAVAILABLE" });
  });
});
