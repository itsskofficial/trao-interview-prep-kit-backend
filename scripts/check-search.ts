/**
 * One live call to the optional web search, to confirm the key and the response shape:
 *
 *   npx tsx scripts/check-search.ts "PostHog"
 *
 * Prints what came back and how each source was logged. Never prints the key.
 */
import { loadConfig, loadEnvFile } from "../src/config";
import { createDiscussionSearch } from "../src/retrieval/discussion";
import { createPageFetcher } from "../src/retrieval/fetcher";

loadEnvFile();
const config = loadConfig();
if (!config.LANGSEARCH_API_KEY) {
  console.error("LANGSEARCH_API_KEY is not set in .env, so the web search is off. Nothing to check.");
  process.exit(2);
}
const fetcher = createPageFetcher({ allowPrivate: false });
const result = await createDiscussionSearch(fetcher, { langSearchApiKey: config.LANGSEARCH_API_KEY })(process.argv[2] ?? "PostHog");
await fetcher.close();
for (const entry of result.log) console.log(`${entry.outcome.padEnd(8)} ${entry.source}${entry.reason ? `: ${entry.reason}` : ""}`);
for (const snippet of result.snippets) console.log(`\n[${snippet.source}] ${snippet.url}\n  ${snippet.text.slice(0, 200)}`);
process.exit(result.log.some((entry) => entry.source === "web-search" && entry.outcome === "skipped") ? 1 : 0);
