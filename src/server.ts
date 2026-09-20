import { createApp } from "./api/app";
import { createRegenerator } from "./builder/regenerator";
import { allowsPrivateUrls, loadConfig, loadEnvFile } from "./config";
import { createJobRunner } from "./jobs/runner";
import { createLlmClientFromConfig } from "./llm";
import { createLogger } from "./logging/logger";
import { createEmbedderFromConfig } from "./similarity";
import { kitRepository } from "./persistence/kits";
import { connectDatabase } from "./persistence/mongo";
import { createPageFetcher } from "./retrieval/fetcher";

loadEnvFile();
const config = loadConfig();
const db = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);

const logger = createLogger(config.LOG_LEVEL);

// Which job a retry belongs to is in that job's trace; this is the process-wide view of how the providers are behaving.
const llm = createLlmClientFromConfig(config, (event) => {
  if (event.type === "retry") logger.warn({ step: event.step, provider: event.provider, waitMs: event.waitMs, reason: event.reason }, "model call retried");
  if (event.type === "failover") logger.warn({ step: event.step, from: event.from, reason: event.reason }, "model provider failed over");
  if (event.type === "repair") logger.info({ step: event.step, provider: event.provider }, "model answer repaired");
});
const fetcher = createPageFetcher({ allowPrivate: allowsPrivateUrls(config) });
// Comparing meaning is an aid: when the embedding call fails the pipeline carries on with a lexical comparison, and says so here.
const embedder = createEmbedderFromConfig(config, (reason) => logger.warn({ reason }, "embeddings unavailable, compared lexically"));
const runner = createJobRunner(db, { llm, fetcher, embedder }, undefined, logger);
const kits = kitRepository(db);
const regenerator = createRegenerator(kits, { llm, fetcher, embedder });

// Jobs only live in this process. Whatever a previous process left unfinished is marked so, and can be retried.
const interrupted = (await runner.recoverInterrupted()) + (await kits.failInterruptedRegenerations());
if (interrupted > 0) logger.warn({ interrupted }, "marked unfinished jobs and regenerations as interrupted");

const server = createApp({ db, config, runner, regenerator, logger }).listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV, provider: config.LLM_PROVIDER }, "API listening");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => void Promise.allSettled([db.close(), fetcher.close()]).finally(() => process.exit(0)));
  });
}
