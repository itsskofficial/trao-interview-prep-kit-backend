/**
 * Who should decide must-have or nice-to-have: the wording rule, the model, or which of them when?
 *
 *   npm run measure:priority [-- --set heldOut]
 *
 * Runs the real extraction prompt over every labelled fragment in fixtures/priority-cases.json, takes the
 * model's own label for the quoted requirement, and scores several ways of combining it with the rule's two
 * signals (the line's own wording, and the heading above it). The policy in src/extraction/priority.ts was
 * chosen from this output; the numbers are recorded there.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig, loadEnvFile } from "../src/config";
import { SYSTEM } from "../src/extraction/extract";
import { normalise } from "../src/extraction/evidence";
import { prioritySignals, type PrioritySignals } from "../src/extraction/priority";
import type { Priority } from "../src/kit/schema";
import { createLlmClientFromConfig } from "../src/llm";
import { wrapUntrusted } from "../src/llm/untrusted";

interface Case {
  jd: string;
  evidence: string;
  expected: Priority | "defer";
  note: string;
}

const Proposed = z.object({ requirements: z.array(z.object({ text: z.string(), evidence: z.string(), priority: z.enum(["must", "nice"]) })) });

/** Ways of combining the rule's signals with the model's label. */
export const POLICIES: Record<string, (signals: PrioritySignals, model: Priority) => Priority> = {
  "rule first (line, then heading, then model)": ({ line, heading }, model) => line ?? heading ?? model,
  "model only": (_signals, model) => model,
  "line, then model": ({ line }, model) => line ?? model,
  "line, then a nice heading, then model": ({ line, heading }, model) => line ?? (heading === "nice" ? "nice" : undefined) ?? model,
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { set: { type: "string" } } });
  loadEnvFile();
  const llm = createLlmClientFromConfig(loadConfig());
  const file = JSON.parse(await readFile("fixtures/priority-cases.json", "utf8")) as { cases: Case[]; heldOut: Case[] };
  const sets: Array<[string, Case[]]> = values.set === "heldOut" ? [["heldOut", file.heldOut]] : values.set === "cases" ? [["cases", file.cases]] : [["cases", file.cases], ["heldOut", file.heldOut]];

  const labels = new Map<string, Array<{ evidence: string; priority: Priority }>>();
  for (const [name, cases] of sets) {
    const decided = cases.filter((entry) => entry.expected !== "defer");
    const rows: Array<{ entry: Case; model?: Priority; signals: PrioritySignals }> = [];
    for (const entry of decided) {
      if (!labels.has(entry.jd)) {
        const answer = await llm.generate({ step: "measure-priority", system: SYSTEM, prompt: `Extract the role and its requirements.\n\n${wrapUntrusted("job_description", entry.jd)}`, schema: Proposed });
        labels.set(entry.jd, answer.requirements);
      }
      const needle = normalise(entry.evidence);
      const found = labels.get(entry.jd)!.find((requirement) => normalise(requirement.evidence).includes(needle) || needle.includes(normalise(requirement.evidence)));
      rows.push({ entry, model: found?.priority, signals: prioritySignals(entry.jd, entry.evidence) });
    }

    const extracted = rows.filter((row) => row.model !== undefined);
    console.log(`\n== ${name}: ${decided.length} cases with a right answer, the model extracted the requirement in ${extracted.length}`);
    for (const [policy, decide] of Object.entries(POLICIES)) {
      const wrong = extracted.filter((row) => decide(row.signals, row.model!) !== row.entry.expected);
      console.log(`  ${String(extracted.length - wrong.length).padStart(2)}/${extracted.length}  ${policy}`);
      for (const row of wrong) console.log(`         wrong: ${row.entry.note} (expected ${row.entry.expected}; line ${row.signals.line ?? "-"}, heading ${row.signals.heading ?? "-"}, model ${row.model})`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
