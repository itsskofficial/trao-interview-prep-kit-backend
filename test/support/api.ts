import type { Express } from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../../src/api/app";
import { loadConfig, type Config } from "../../src/config";
import { connectDatabase, type Database } from "../../src/persistence/mongo";

export interface TestApi {
  app: Express;
  db: Database;
  config: Config;
  /** Registers a fresh user and returns an agent that carries their session cookie. */
  signedIn(email?: string): Promise<ReturnType<typeof request.agent>>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startTestApi(overrides: Partial<Config> = {}): Promise<TestApi> {
  const mongo = await MongoMemoryServer.create();
  const config = { ...loadConfig({ NODE_ENV: "test", JWT_SECRET: "a-test-secret-that-is-long-enough-123" }), ...overrides };
  const db = await connectDatabase(mongo.getUri(), "test");
  const app = createApp({ db, config });
  let users = 0;

  return {
    app,
    db,
    config,
    async signedIn(email = `user${++users}@example.com`) {
      const agent = request.agent(app);
      await agent.post("/api/auth/register").send({ email, password: "correct horse battery" }).expect(201);
      return agent;
    },
    async reset() {
      await Promise.all([db.users.deleteMany({}), db.kits.deleteMany({})]);
    },
    async close() {
      await db.close();
      await mongo.stop();
    },
  };
}
