import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runBatch } from "../batch/run";
import { BatchInputSchema, type BatchOutput } from "../batch/schema";
import { allowsPrivateUrls, caseTimeoutMs, loadConfig, loadEnvFile } from "../config";
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
    // Windows editors like to start a UTF-8 file with a byte-order mark, which JSON.parse refuses.
    cases = BatchInputSchema.parse(JSON.parse((await readFile(values.input, "utf8")).replace(/^\uFEFF/, "")));
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
  const target = path.resolve(values.output);
  await mkdir(path.dirname(target), { recursive: true });
  // Written to a temporary file and renamed, so a crash never leaves a half-written result.
  const write = async (output: BatchOutput) => {
    await writeFile(`${target}.tmp`, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    await rename(`${target}.tmp`, target);
  };
  const output = await runBatch(cases, {
    llm,
    fetcher,
    concurrency: config.BATCH_CONCURRENCY,
    caseTimeoutMs: caseTimeoutMs(config),
    log: (line) => console.error(line),
    // The file is rewritten after every case, so a run stopped early still leaves what it finished.
    onPartial: (finished) => write({ version: "1.0", generated_at: new Date().toISOString(), kits: finished }),
  }).finally(() => fetcher.close());

  await write(output);

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
