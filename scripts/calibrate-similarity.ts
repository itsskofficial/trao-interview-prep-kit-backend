/**
 * Chooses similarity thresholds from labelled pairs instead of from a feeling.
 *
 *   npm run calibrate            semantic (needs GEMINI_API_KEY) and lexical
 *   npm run calibrate -- --lexical
 *
 * For each task and each embedder it sweeps the threshold and prints precision,
 * recall and F1, then the threshold it would pick. The numbers chosen from a
 * real run are written into src/similarity/thresholds.ts by hand, with the date.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadEnvFile } from "../src/config";
import { nameDifferentThings } from "../src/similarity/duplicates";
import { geminiEmbedder, lexicalEmbedder, similarity, type Embedder } from "../src/similarity/embedder";

interface Labelled {
  duplicates: Array<{ a: string; b: string; same: boolean }>;
  grounding: Array<{ claim: string; sentence: string; supported: boolean }>;
}

interface Scored {
  /** Set when code would refuse the pair whatever its score (duplicates only). */
  vetoed?: boolean;
  score: number;
  positive: boolean;
  label: string;
}

async function score(embedder: Embedder, pairs: Array<{ left: string; right: string; positive: boolean }>, veto?: (left: string, right: string) => boolean): Promise<Scored[]> {
  const { vectors } = await embedder.embed(pairs.flatMap((pair) => [pair.left, pair.right]));
  return pairs.map((pair, index) => ({
    score: similarity(vectors[index * 2]!, vectors[index * 2 + 1]!),
    positive: pair.positive,
    ...(veto ? { vetoed: veto(pair.left, pair.right) } : {}),
    label: `${pair.left.slice(0, 48)} | ${pair.right.slice(0, 48)}`,
  }));
}

function sweep(scored: Scored[], prefer: "precision" | "f1"): number {
  const rows: Array<{ threshold: number; precision: number; recall: number; f1: number }> = [];
  for (let threshold = 0.3; threshold <= 0.971; threshold += 0.02) {
    const kept = scored.filter((pair) => pair.score >= threshold && !pair.vetoed);
    const truePositives = kept.filter((pair) => pair.positive).length;
    const positives = scored.filter((pair) => pair.positive).length;
    const precision = kept.length === 0 ? 1 : truePositives / kept.length;
    const recall = truePositives / positives;
    rows.push({ threshold: Number(threshold.toFixed(2)), precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) });
  }
  for (const row of rows) console.log(`    ${row.threshold.toFixed(2)}  precision ${row.precision.toFixed(2)}  recall ${row.recall.toFixed(2)}  f1 ${row.f1.toFixed(2)}`);

  // Removing a question that was not a duplicate loses the user something; keeping a duplicate only wastes a slot.
  // So for duplicates: the lowest threshold that makes no mistake. For grounding: the best balance, precision first on a tie.
  const perfect = rows.filter((row) => row.precision === 1);
  const best =
    prefer === "precision" && perfect.length > 0
      ? perfect.sort((a, b) => b.recall - a.recall || a.threshold - b.threshold)[0]!
      : [...rows].sort((a, b) => b.f1 - a.f1 || b.precision - a.precision)[0]!;
  console.log(`  -> pick ${best.threshold.toFixed(2)} (precision ${best.precision.toFixed(2)}, recall ${best.recall.toFixed(2)})`);

  const wrong = scored.filter((pair) => (pair.score >= best.threshold && !pair.vetoed) !== pair.positive);
  for (const pair of wrong) console.log(`     wrong at that threshold: ${pair.score.toFixed(3)} ${pair.positive ? (pair.vetoed ? "missed (named terms differ)" : "missed") : "false alarm"}: ${pair.label}`);
  return best.threshold;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { lexical: { type: "boolean" }, task: { type: "string" } } });
  loadEnvFile();
  const config = loadConfig();
  const labelled = JSON.parse(await readFile(path.resolve("fixtures/similarity.json"), "utf8")) as Labelled;

  const embedders: Array<[string, Embedder]> = [["lexical", lexicalEmbedder()]];
  if (!values.lexical && config.GEMINI_API_KEY && config.GEMINI_EMBEDDING_MODEL !== "off") {
    embedders.unshift([
      `semantic (${config.GEMINI_EMBEDDING_MODEL})`,
      geminiEmbedder({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_EMBEDDING_MODEL, textsPerMinute: 1_000 }),
    ]);
  }

  for (const [name, embedder] of embedders) {
    console.log(`\n== ${name}`);
    if (values.task !== "grounding") console.log("  duplicate questions:");
    if (values.task !== "grounding") sweep(await score(embedder, labelled.duplicates.map((pair) => ({ left: pair.a, right: pair.b, positive: pair.same })), nameDifferentThings), "precision");
    if (values.task !== "duplicates") console.log("  claim supported by sentence:");
    if (values.task !== "duplicates") sweep(await score(embedder, labelled.grounding.map((pair) => ({ left: pair.claim, right: pair.sentence, positive: pair.supported }))), "f1");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
