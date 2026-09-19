import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { startFixtureServer } from "../fixtures/server";
import { runBatch } from "../src/batch/run";
import { BatchOutputSchema, type BatchOutput, type CaseResult } from "../src/batch/schema";
import { allowsPrivateUrls, loadConfig, loadEnvFile } from "../src/config";
import { findUncovered } from "../src/coverage/coverage";
import type { Kit } from "../src/kit/schema";
import { validateKit } from "../src/kit/validate";
import { createLlmClientFromConfig } from "../src/llm";
import { createPageFetcher } from "../src/retrieval/fetcher";

/**
 * Runs the batch pipeline over the fixture companies with a live model and
 * scores the output against the brief's published automated rubric
 * (extraction 20, coverage and schedule 15, research and sequencing 10,
 * robustness 10). It is how we know what the evaluators' run will see before
 * they run it. Uses about 40 model requests.
 *
 *   npm run selfcheck                         run live, save the output to .selfcheck/kits.json, score it
 *   npm run selfcheck -- --from <kits.json>   score an existing output file without calling the model
 */

interface Expected {
  must: string[][];
  nice: string[][];
  hiringPage: string | null;
  stages?: string[];
  reachable: boolean;
  thin?: boolean;
  forbidden?: string[];
}

interface Check {
  area: "extraction" | "coverage" | "research" | "robustness";
  label: string;
  pass: boolean;
  detail?: string;
}

const WEIGHTS: Record<Check["area"], number> = { extraction: 20, coverage: 15, research: 10, robustness: 10 };
const TIME_LIMIT_MS = 15 * 60 * 1000;

const found = (kit: Kit, keywords: string[], priority: "must" | "nice") =>
  kit.role.requirements.find((r) => r.priority === priority && keywords.every((k) => r.text.toLowerCase().includes(k) || (r.evidence ?? "").toLowerCase().includes(k)));

function checkCase(result: CaseResult, expected: Expected, jd: string, days: number): Check[] {
  const checks: Check[] = [];
  const add = (area: Check["area"], label: string, pass: boolean, detail?: string) => checks.push({ area, label, pass, detail });

  add("robustness", "case produced a kit (status ok)", result.status === "ok", result.error?.message);
  if (result.status !== "ok") return checks;
  const { kit } = result;
  const validation = validateKit(kit);
  add("robustness", "kit matches the required structure", validation.ok, validation.ok ? undefined : validation.issues.join("; "));

  // Extraction: must-haves found and marked correctly, nothing invented.
  for (const keywords of expected.must) add("extraction", `must-have found: ${keywords.join(" + ")}`, Boolean(found(kit, keywords, "must")));
  for (const keywords of expected.nice) add("extraction", `nice-to-have marked nice: ${keywords.join(" + ")}`, Boolean(found(kit, keywords, "nice")));
  const invented = kit.role.requirements.filter((r) => !r.evidence || !jd.toLowerCase().replace(/\s+/g, " ").includes(r.evidence.toLowerCase().replace(/\s+/g, " ")));
  add("extraction", "every requirement quotes the job description", invented.length === 0, invented.map((r) => r.text).join("; "));
  const extra = kit.role.requirements.length - expected.must.length - expected.nice.length;
  add("extraction", "no more requirements than the posting states", extra <= 1, `${kit.role.requirements.length} extracted, ${expected.must.length + expected.nice.length} expected`);
  if (expected.forbidden) {
    const leaked = expected.forbidden.filter((word) => JSON.stringify(kit).toLowerCase().includes(word));
    add("extraction", "planted instructions had no effect", leaked.length === 0, leaked.join(", "));
  }
  if (expected.thin) add("extraction", "thin description is reported as thin", (kit.notes ?? []).some((note) => /thin/i.test(note)));

  // Coverage and schedule.
  const uncoveredMust = findUncovered(kit.role.requirements, kit.questions).filter((r) => r.priority === "must");
  add("coverage", "every must-have requirement has a question", uncoveredMust.length === 0, uncoveredMust.map((r) => r.id).join(", "));
  add("coverage", `schedule has exactly ${days} day(s)`, kit.schedule.days.length === days && kit.schedule.days_available === days);
  const scheduled = new Set(kit.schedule.days.flatMap((d) => d.question_ids));
  add("coverage", "every question is scheduled", kit.questions.every((q) => scheduled.has(q.id)));
  add("coverage", "every day has a focus and integer minutes", kit.schedule.days.every((d) => d.focus.length > 0 && Number.isInteger(d.minutes)));
  const mustIds = new Set(kit.role.requirements.filter((r) => r.priority === "must").map((r) => r.id));
  // With one day everything is on day 1, so the claim is about what comes first, not about everything on the day.
  const opener = kit.questions.find((q) => q.id === kit.schedule.days[0]?.question_ids[0]);
  add("coverage", "day 1 starts with must-have material", mustIds.size === 0 || Boolean(opener?.requirement_ids.some((id) => mustIds.has(id))));

  // Research and sequencing.
  const log = kit.research_log ?? [];
  add("research", "company site crawl is recorded", log.some((e) => e.source === "company-site"));
  if (expected.reachable) {
    add("research", "pages used are listed", kit.source.pages_used.length > 0);
    add("research", "public discussion was searched", log.some((e) => ["hacker-news", "stack-exchange-workplace", "public-discussion"].includes(e.source)));
  } else {
    add("research", "unreachable site is recorded, not fatal", kit.source.pages_used.length === 0 && log.some((e) => e.outcome === "failed"));
    add("research", "brief is honest about finding nothing", /could not|no information/i.test(kit.company_brief.summary) && kit.company_brief.sources.length === 0);
  }
  if (expected.hiringPage) {
    add("research", "hiring page found by crawling", kit.source.pages_used.some((url) => url.endsWith(expected.hiringPage!)), kit.source.pages_used.join(", "));
    for (const stage of expected.stages ?? []) add("research", `published stage recognised: ${stage}`, (kit.hiring_stages ?? []).some((s) => s.toLowerCase().includes(stage)));
  } else if (expected.reachable) {
    add("research", "missing hiring page is reported, not invented", (kit.hiring_stages ?? []).length === 0 && log.some((e) => e.source === "hiring-page" && e.outcome === "empty"));
  }
  const categories = new Set(kit.questions.map((q) => q.category));
  add("research", "question categories generated separately", expected.thin ? categories.size >= 1 : categories.size >= 2, [...categories].join(", "));
  add("research", "coverage was checked", kit.coverage.passes >= 1);
  return checks;
}

loadEnvFile();
const config = loadConfig();
const cases = JSON.parse(await readFile("fixtures/cases.json", "utf8")) as Array<{ id: string; jd: string; days: number }>;
const expectations = JSON.parse(await readFile("fixtures/expected.json", "utf8")) as Record<string, Expected>;

const { values } = parseArgs({ options: { from: { type: "string" } } });
let output: BatchOutput;
let elapsed = 0;

if (values.from) {
  output = JSON.parse(await readFile(values.from, "utf8")) as BatchOutput;
} else {
  const site = await startFixtureServer(8099).catch(() => undefined); // already running is fine
  const fetcher = createPageFetcher({ allowPrivate: allowsPrivateUrls(config) });
  const started = Date.now();
  output = await runBatch(cases, {
    llm: createLlmClientFromConfig(config),
    fetcher,
    concurrency: config.BATCH_CONCURRENCY,
    caseTimeoutMs: config.CASE_TIMEOUT_MS,
    log: (line) => console.log(line),
  });
  elapsed = Date.now() - started;
  await fetcher.close();
  await site?.close();
  await mkdir(".selfcheck", { recursive: true });
  await writeFile(".selfcheck/kits.json", JSON.stringify(output, null, 2));
}

const all: Check[] = [
  { area: "robustness", label: "output matches the Appendix B shape", pass: BatchOutputSchema.safeParse(output).success },
  ...(values.from ? [] : [{ area: "robustness" as const, label: `run finished inside 15 minutes (${Math.round(elapsed / 1000)}s)`, pass: elapsed < TIME_LIMIT_MS }]),
  { area: "robustness", label: "one entry per case", pass: output.kits.length === cases.length },
];
for (const testCase of cases) {
  const result = output.kits.find((kit) => kit.id === testCase.id)!;
  const checks = checkCase(result, expectations[testCase.id]!, testCase.jd, testCase.days);
  console.log(`\n${testCase.id}`);
  for (const check of checks) console.log(`  ${check.pass ? "PASS" : "FAIL"}  [${check.area}] ${check.label}${!check.pass && check.detail ? `  -> ${check.detail}` : ""}`);
  all.push(...checks);
}

console.log("\nEstimated automated score");
let total = 0;
for (const area of Object.keys(WEIGHTS) as Array<Check["area"]>) {
  const checks = all.filter((check) => check.area === area);
  const points = (checks.filter((check) => check.pass).length / checks.length) * WEIGHTS[area];
  total += points;
  console.log(`  ${area.padEnd(11)} ${points.toFixed(1).padStart(5)} / ${WEIGHTS[area]}   (${checks.filter((c) => c.pass).length}/${checks.length} checks)`);
}
console.log(`  ${"total".padEnd(11)} ${total.toFixed(1).padStart(5)} / 55`);
process.exit(all.every((check) => check.pass) ? 0 : 1);
