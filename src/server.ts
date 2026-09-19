import { createApp } from "./api/app";
import { createRegenerator } from "./builder/regenerator";
import { allowsPrivateUrls, loadConfig, loadEnvFile } from "./config";
import { createJobRunner } from "./jobs/runner";
import { createLlmClientFromConfig } from "./llm";
import { kitRepository } from "./persistence/kits";
import { connectDatabase } from "./persistence/mongo";
import { createPageFetcher } from "./retrieval/fetcher";

loadEnvFile();
const config = loadConfig();
const db = await connectDatabase(config.MONGODB_URI, config.MONGODB_DB);

const llm = createLlmClientFromConfig(config);
const fetcher = createPageFetcher({ allowPrivate: allowsPrivateUrls(config) });
const runner = createJobRunner(db, { llm, fetcher });
const kits = kitRepository(db);
const regenerator = createRegenerator(kits, { llm, fetcher });

// Jobs only live in this process. Whatever a previous process left unfinished is marked so, and can be retried.
const interrupted = (await runner.recoverInterrupted()) + (await kits.failInterruptedRegenerations());
if (interrupted > 0) console.log(`Marked ${interrupted} unfinished job(s) or regeneration(s) as interrupted.`);

const server = createApp({ db, config, runner, regenerator }).listen(config.PORT, () => {
  console.log(`API listening on port ${config.PORT} (${config.NODE_ENV})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => void Promise.allSettled([db.close(), fetcher.close()]).finally(() => process.exit(0)));
  });
}
