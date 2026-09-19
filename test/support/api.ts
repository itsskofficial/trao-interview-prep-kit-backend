import type { Express } from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../../src/api/app";
import { loadConfig, type Config } from "../../src/config";
import { createJobRunner, type JobRunner } from "../../src/jobs/runner";
import type { PipelineDeps } from "../../src/pipeline/build-kit";
import { routedModel } from "./model";
import { connectDatabase, type Database } from "../../src/persistence/mongo";

export interface TestApi {
  app: Express;
  db: Database;
  config: Config;
  runner: JobRunner;
  /** Registers a fresh user and returns an agent that carries their session cookie. */
  signedIn(email?: string): Promise<ReturnType<typeof request.agent>>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A company site that cannot be reached; retrieval has its own tests. */
const unreachable: PipelineDeps["fetcher"] = {
  fetchPage: async (url) => ({ ok: false, url, reason: "network", detail: "unreachable in this test" }),
  close: async () => undefined,
};

export async function startTestApi(overrides: Partial<Config> = {}, pipeline: Partial<PipelineDeps> = {}): Promise<TestApi> {
  const mongo = await MongoMemoryServer.create();
  const config = { ...loadConfig({ NODE_ENV: "test", JWT_SECRET: "a-test-secret-that-is-long-enough-123" }), ...overrides };
  const db = await connectDatabase(mongo.getUri(), "test");
  const runner = createJobRunner(db, { llm: routedModel().llm, fetcher: unreachable, ...pipeline });
  const app = createApp({ db, config, runner });
  let users = 0;

  return {
    app,
    db,
    config,
    runner,
    async signedIn(email = `user${++users}@example.com`) {
      const agent = request.agent(app);
      await agent.post("/api/auth/register").send({ email, password: "correct horse battery" }).expect(201);
      return agent;
    },
    async reset() {
      await runner.idle();
      await Promise.all([db.users.deleteMany({}), db.kits.deleteMany({}), db.jobs.deleteMany({})]);
    },
    async close() {
      await runner.idle();
      await db.close();
      await mongo.stop();
    },
  };
}
