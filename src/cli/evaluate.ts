import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runBatch } from "../batch/run";
import { BatchInputSchema } from "../batch/schema";
import { allowsPrivateUrls, loadConfig, loadEnvFile } from "../config";
import { createLlmClientFromConfig } from "../llm";
import { createPageFetcher } from "../retrieval/fetcher";

const USAGE = "Usage: npm run evaluate -- --input <cases.json> --output <kits.json>";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" } } });
  if (!values.input || !values.output) {
    console.error(USAGE);
    return 2;
  }

  let cases: unknown[];
  try {
    cases = BatchInputSchema.parse(JSON.parse(await readFile(values.input, "utf8")));
  } catch (error) {
    console.error(`Could not read cases from ${values.input}: ${error instanceof Error ? error.message : error}`);
    console.error("Expected a JSON array of { id, jd, company_url, days }.");
    return 2;
  }

  loadEnvFile();
  const config = loadConfig();
  const llm = createLlmClientFromConfig(config, (event) => {
    if (event.type === "retry") console.error(`  ${event.step}: ${event.reason} Retrying in ${Math.round(event.waitMs / 1000)}s.`);
    if (event.type === "failover") console.error(`  ${event.step}: ${event.from} unavailable (${event.reason}).`);
  });

  console.error(`Running ${cases.length} case(s) with ${config.LLM_PROVIDER}...`);
  const fetcher = createPageFetcher({ allowPrivate: allowsPrivateUrls(config) });
  const output = await runBatch(cases, {
    llm,
    fetcher,
    concurrency: config.BATCH_CONCURRENCY,
    caseTimeoutMs: config.CASE_TIMEOUT_MS,
    log: (line) => console.error(line),
  }).finally(() => fetcher.close());

  // Write to a temporary file first so a crash never leaves a half-written result.
  const target = path.resolve(values.output);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(`${target}.tmp`, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await rename(`${target}.tmp`, target);

  const ok = output.kits.filter((kit) => kit.status === "ok").length;
  console.error(`Wrote ${target}: ${ok} ok, ${output.kits.length - ok} failed.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
