import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Regenerator } from "../builder/regenerator";
import type { Config } from "../config";
import type { JobRunner } from "../jobs/runner";
import { requestLogger, silentLogger, type Logger } from "../logging/logger";
import { kitRepository } from "../persistence/kits";
import type { Database } from "../persistence/mongo";
import { authRouter, requireAuth } from "./auth";
import { builderRouter } from "./builder";
import { errorHandler, notFoundHandler } from "./errors";
import { jobsRouter } from "./jobs";
import { kitsRouter } from "./kits";
import { createUsageLimiter } from "./limits";
import { practiceRouter } from "./practice";

export interface AppDeps {
  db: Database;
  config: Config;
  runner: JobRunner;
  regenerator: Regenerator;
  logger?: Logger;
}

export function createApp({ db, config, runner, regenerator, logger = silentLogger }: AppDeps): Express {
  const app = express();
  const kits = kitRepository(db);
  const limits = createUsageLimiter(db, config);
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: the host's load balancer, so rate limiting sees the real client address

  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(cors({ origin: config.FRONTEND_ORIGIN, credentials: true }));
  // A job description is a few kilobytes and a batch file a few dozen; anything much larger is not a real request.
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.use("/api/auth", authRouter(db, config));
  app.use("/api/kits", requireAuth(config), kitsRouter(kits), builderRouter(kits, regenerator, limits), practiceRouter(kits));
  app.use("/api/jobs", requireAuth(config), jobsRouter(db, kits, runner, limits, config.MAX_ACTIVE_JOBS));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
