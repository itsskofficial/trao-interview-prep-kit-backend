import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The whole backend with nothing to set up: an in-memory MongoDB, the offline stand-in for the
 * model, and the fixture company sites on port 8099. Data is lost when the process stops.
 *
 *   npm run dev:offline
 */

// Run from the backend folder wherever the command was started, so the MongoDB binary that the
// test suite already downloaded is found in this package's cache instead of being fetched again.
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

// Reuse the MongoDB binary the test suite already downloaded, if there is one, instead of fetching it again.
process.env.MONGOMS_PREFER_GLOBAL_PATH ??= "false";
const cache = path.resolve("node_modules/.cache/mongodb-memory-server");
const cached = existsSync(cache) ? readdirSync(cache).find((file) => file.startsWith("mongod-") && !file.endsWith(".lock")) : undefined;
if (cached) process.env.MONGOMS_SYSTEM_BINARY ??= path.join(cache, cached);

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri();
process.env.LLM_PROVIDER ??= "offline";
process.env.NODE_ENV ??= "development";

const { startFixtureServer } = await import("../fixtures/server");
await startFixtureServer(Number(process.env.FIXTURE_PORT ?? 8099))
  .then(({ origin }) => console.log(`Fixture company sites on ${origin}/ (try ${origin}/acme/)`))
  .catch(() => console.log("Fixture sites: port already in use, assuming they are running."));

await import("../src/server");
