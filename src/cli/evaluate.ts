import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { runBatch } from "../batch/run";
import { BatchInputSchema, type BatchOutput } from "../batch/schema";
import { allowsPrivateUrls, caseTimeoutMs, loadConfig, loadEnvFile } from "../config";
import { createLlmClientFromConfig } from "../llm";
import { createPageFetcher } from "../retrieval/fetcher";
import { createEmbedderFromConfig } from "../similarity";
import type { RunTrace } from "../trace/trace";

const USAGE = "Usage: npm run evaluate -- --input <cases.json> --output <kits.json> [--trace <trace.json>]";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" }, trace: { type: "string" } } });
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
  const writeJson = async (file: string, value: unknown) => {
    await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(`${file}.tmp`, file);
  };
  const write = (output: BatchOutput) => writeJson(target, output);

  // The graded file stays exactly what it was. What each run did goes to its own file, and only when asked for.
  const traces = new Map<string, RunTrace>();
  const traceTarget = values.trace ? path.resolve(values.trace) : undefined;
  if (traceTarget) await mkdir(path.dirname(traceTarget), { recursive: true });
  const writeTraces = async () => {
    if (traceTarget) await writeJson(traceTarget, { version: "1.0", traces: [...traces].map(([id, trace]) => ({ id, trace })) });
  };
  const output = await runBatch(cases, {
    llm,
    fetcher,
    embedder: createEmbedderFromConfig(config, (reason) => console.error(`  Embeddings unavailable (${reason}); compared lexically.`)),
    concurrency: config.BATCH_CONCURRENCY,
    caseTimeoutMs: caseTimeoutMs(config),
    log: (line) => console.error(line),
    // The file is rewritten after every case, so a run stopped early still leaves what it finished.
    onPartial: async (finished) => {
      await write({ version: "1.0", generated_at: new Date().toISOString(), kits: finished });
      await writeTraces();
    },
    onCaseTrace: (id, trace) => traces.set(id, trace),
  }).finally(() => fetcher.close());

  await write(output);
  await writeTraces();
  console.error(summarise([...traces.values()]));

  const ok = output.kits.filter((kit) => kit.status === "ok").length;
  console.error(`Wrote ${target}: ${ok} ok, ${output.kits.length - ok} failed.`);
  return 0;
}

/** One line on what the run cost, so rate-limit trouble is visible without opening a file. */
function summarise(traces: RunTrace[]): string {
  const total = (pick: (trace: RunTrace) => number) => traces.reduce((sum, trace) => sum + pick(trace), 0);
  const models = [...new Set(traces.flatMap((trace) => trace.totals.models))].join(", ") || "none";
  return (
    `Model calls: ${total((t) => t.totals.llmCalls)} (${total((t) => t.totals.retries)} retried, ${total((t) => t.totals.repairs)} repaired, ${total((t) => t.totals.failovers)} failed over), ` +
    `tokens in/out: ${total((t) => t.totals.inputTokens)}/${total((t) => t.totals.outputTokens)}, ` +
    `pages fetched: ${total((t) => t.totals.fetches)}, answered by: ${models}.`
  );
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
