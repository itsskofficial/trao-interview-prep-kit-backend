import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Regenerator } from "../builder/regenerator";
import type { Config } from "../config";
import type { JobRunner } from "../jobs/runner";
import { kitRepository } from "../persistence/kits";
import type { Database } from "../persistence/mongo";
import { authRouter, requireAuth } from "./auth";
import { builderRouter } from "./builder";
import { errorHandler, notFoundHandler } from "./errors";
import { jobsRouter } from "./jobs";
import { kitsRouter } from "./kits";
import { practiceRouter } from "./practice";

export interface AppDeps {
  db: Database;
  config: Config;
  runner: JobRunner;
  regenerator: Regenerator;
}

export function createApp({ db, config, runner, regenerator }: AppDeps): Express {
  const app = express();
  const kits = kitRepository(db);
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: the host's load balancer, so rate limiting sees the real client address

  app.use(helmet());
  app.use(cors({ origin: config.FRONTEND_ORIGIN, credentials: true }));
  // A job description is a few kilobytes and a batch file a few dozen; anything much larger is not a real request.
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.use("/api/auth", authRouter(db, config));
  app.use("/api/kits", requireAuth(config), kitsRouter(kits), builderRouter(kits, regenerator), practiceRouter(kits));
  app.use("/api/jobs", requireAuth(config), jobsRouter(db, kits, runner));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
