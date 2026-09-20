/**
 * LLM-as-judge over a finished batch output.
 *
 *   npm run judge -- --from kits.json [--out judge-report.json] [--min 3.5]
 *
 * Scores every question and flashcard against the rubric in src/evals/judge.ts, checks the judge
 * itself with planted bad items, and prints the weakest real items with the judge's reasons.
 *
 * Exit codes: 0 fine, 1 the mean is below --min, 2 the judge could not be trusted or could not run.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { BatchOutputSchema } from "../src/batch/schema";
import { loadConfig, loadEnvFile } from "../src/config";
import { judgeConfigFor, judgeKit, summarise, type KitJudgement } from "../src/evals/judge";
import { createLlmClientFromConfig } from "../src/llm";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { from: { type: "string" }, out: { type: "string" }, min: { type: "string" } } });
  if (!values.from) {
    console.error("Usage: npm run judge -- --from <kits.json> [--out <report.json>] [--min <1-5>]");
    return 2;
  }
  const output = BatchOutputSchema.parse(JSON.parse((await readFile(values.from, "utf8")).replace(/^\uFEFF/, "")));
  const kits = output.kits.flatMap((entry) => (entry.status === "ok" ? [{ id: entry.id, kit: entry.kit }] : []));
  if (kits.length === 0) {
    console.error("No kits to judge.");
    return 2;
  }

  loadEnvFile();
  const base = loadConfig();
  if (base.LLM_PROVIDER === "offline") {
    console.error("The offline provider is mechanical and cannot judge. Set LLM_PROVIDER and a key.");
    return 2;
  }
  const { config, note } = judgeConfigFor(base, kits.flatMap(({ kit }) => kit.generator?.models ?? []));
  console.log(note);

  const answeredBy = new Set<string>();
  const llm = createLlmClientFromConfig(config, (event) => {
    if (event.type === "retry") console.error(`  ${event.step}: ${event.reason} Retrying in ${Math.round(event.waitMs / 1000)}s.`);
  });
  const recording: typeof llm = { generate: (request) => llm.generate({ ...request, onCall: (call) => call.outcome === "ok" && answeredBy.add(call.provider) }) };

  const judgements: KitJudgement[] = [];
  for (const { id, kit } of kits) {
    console.log(`Judging ${id} (${kit.questions.length} questions, ${kit.flashcards.length} flashcards)...`);
    judgements.push(await judgeKit(id, kit, recording));
  }

  const report = summarise(judgements, [...answeredBy].join(", ") || config.LLM_PROVIDER);
  if (values.out) await writeFile(path.resolve(values.out), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`\nJudge: ${report.judge}`);
  for (const kit of report.kits) console.log(`  ${kit.id.padEnd(32)} questions ${kit.questionMean ?? "-"}  flashcards ${kit.flashcardMean ?? "-"}`);
  console.log(`\nOverall: ${report.overall.mean} over ${report.overall.items} items (questions ${report.overall.questionMean}, flashcards ${report.overall.flashcardMean}${report.overall.unscored ? `, ${report.overall.unscored} unscored` : ""})`);
  console.log(`By dimension: ${Object.entries(report.overall.byDimension).map(([name, value]) => `${name} ${value}`).join(", ")}`);
  console.log(`\nJudge check: ${report.judgeCheck.verdict}`);
  for (const canary of report.judgeCheck.canaries) console.log(`  ${canary.kit} ${canary.ref}: ${canary.dimension} ${canary.score}`);
  console.log("\nWeakest real items:");
  for (const item of report.weakest) console.log(`  ${item.mean}  [${item.kit} ${item.ref}] ${item.text.slice(0, 90)}\n        ${item.reason}`);

  if (!report.judgeCheck.reliable) return 2;
  const min = values.min ? Number(values.min) : undefined;
  if (min !== undefined && report.overall.mean !== null && report.overall.mean < min) {
    console.error(`\nMean ${report.overall.mean} is below the required ${min}.`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
