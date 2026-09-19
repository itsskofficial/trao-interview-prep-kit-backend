import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * The whole backend with nothing to set up: an in-memory MongoDB, the offline stand-in for the
 * model, and the fixture company sites on port 8099. Data is lost when the process stops.
 *
 *   npm run dev:offline
 */
const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri();
process.env.LLM_PROVIDER ??= "offline";
process.env.NODE_ENV ??= "development";

const { startFixtureServer } = await import("../fixtures/server");
await startFixtureServer(Number(process.env.FIXTURE_PORT ?? 8099))
  .then(({ origin }) => console.log(`Fixture company sites on ${origin}/ (try ${origin}/acme/)`))
  .catch(() => console.log("Fixture sites: port already in use, assuming they are running."));

await import("../src/server");
