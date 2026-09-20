/**
 * Who should decide must-have or nice-to-have: the wording rule, the model, or which of them when?
 *
 *   npm run measure:priority [-- --set heldOut]
 *
 * Runs the real extraction prompt over every labelled fragment in fixtures/priority-cases.json, takes the
 * model's own label for the quoted requirement, and scores several ways of combining it with the rule's two
 * signals (the line's own wording, and the heading above it). The policy in src/extraction/priority.ts was
 * chosen from this output; the numbers are recorded there.
 *
 * Exits 1 if the policy in use scores below its floor on either set. A case whose requirement the model did not
 * extract on its own counts against the score: a measurement that quietly drops its hard cases is not one.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig, loadEnvFile } from "../src/config";
import { SYSTEM } from "../src/extraction/extract";
import { containsPhrase, normalise } from "../src/extraction/evidence";
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

const IN_USE = "line, then an explicit heading, then model (in use)";
/** What the policy in use scored when it was adopted, less one case of slack for the model having an off day. */
const FLOOR: Record<string, number> = { cases: 38, heldOut: 17 };

/**
 * Which proposed requirement answers which case. Exact evidence first. Otherwise a requirement whose evidence
 * contains the case's, but only if no other case of the same posting wants it too: a model that returned
 * "Strong Python; Airflow a bonus" as one requirement has given one label to two cases, and that label is
 * neither's. Each requirement answers at most one case.
 */
function assign(cases: Case[], proposed: Array<{ evidence: string; priority: Priority }>): Map<Case, Priority> {
  const assigned = new Map<Case, Priority>();
  const used = new Set<number>();
  const normalised = proposed.map((requirement) => normalise(requirement.evidence));
  for (const entry of cases) {
    const index = normalised.findIndex((evidence, i) => !used.has(i) && evidence === normalise(entry.evidence));
    if (index !== -1) {
      used.add(index);
      assigned.set(entry, proposed[index]!.priority);
    }
  }
  for (const entry of cases.filter((candidate) => !assigned.has(candidate))) {
    const needle = normalise(entry.evidence);
    // The model may quote more than the case does (the whole line) or less (one item of "Python plus SQL"). Either way it must be
    // there as whole words: a stray fragment like "th" is inside "Strong Python" and identifies nothing.
    const overlaps = (evidence: string, wanted: string) => containsPhrase(evidence, wanted) || containsPhrase(wanted, evidence);
    const index = normalised.findIndex((evidence, i) => !used.has(i) && overlaps(evidence, needle));
    if (index === -1) continue;
    const contested = cases.some((other) => other !== entry && !assigned.has(other) && overlaps(normalised[index]!, normalise(other.evidence)));
    if (contested) continue;
    used.add(index);
    assigned.set(entry, proposed[index]!.priority);
  }
  return assigned;
}

/** Ways of combining the rule's signals with the model's label. */
export const POLICIES: Record<string, (signals: PrioritySignals, model: Priority) => Priority> = {
  "rule first (line, then heading, then model)": ({ line, heading }, model) => line ?? heading ?? model,
  "model only": (_signals, model) => model,
  "line, then model": ({ line }, model) => line ?? model,
  "line, then a nice heading, then model": ({ line, heading }, model) => line ?? (heading === "nice" ? "nice" : undefined) ?? model,
  "line, then an explicit heading, then model (in use)": ({ line, heading, headingIsExplicit }, model) => line ?? (headingIsExplicit ? heading : undefined) ?? model,
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { set: { type: "string" } } });
  loadEnvFile();
  const llm = createLlmClientFromConfig(loadConfig());
  const file = JSON.parse(await readFile("fixtures/priority-cases.json", "utf8")) as { cases: Case[]; heldOut: Case[] };
  const sets: Array<[string, Case[]]> = values.set === "heldOut" ? [["heldOut", file.heldOut]] : values.set === "cases" ? [["cases", file.cases]] : [["cases", file.cases], ["heldOut", file.heldOut]];

  const labels = new Map<string, Array<{ evidence: string; priority: Priority }>>();
  let belowFloor = false;
  for (const [name, cases] of sets) {
    const decided = cases.filter((entry) => entry.expected !== "defer");
    const rows: Array<{ entry: Case; model?: Priority; signals: PrioritySignals }> = [];
    for (const entry of decided) {
      if (!labels.has(entry.jd)) {
        const answer = await llm.generate({ step: "measure-priority", system: SYSTEM, prompt: `Extract the role and its requirements.\n\n${wrapUntrusted("job_description", entry.jd)}`, schema: Proposed });
        labels.set(entry.jd, answer.requirements);
      }
    }
    for (const jd of new Set(decided.map((entry) => entry.jd))) {
      const sameposting = decided.filter((entry) => entry.jd === jd);
      const assigned = assign(sameposting, labels.get(jd)!);
      for (const entry of sameposting) rows.push({ entry, model: assigned.get(entry), signals: prioritySignals(entry.jd, entry.evidence) });
    }

    const missing = rows.filter((row) => row.model === undefined);
    console.log(`\n== ${name}: ${decided.length} cases with a right answer${missing.length > 0 ? `; the model did not extract ${missing.length} on their own: ${missing.map((row) => row.entry.note).join(", ")}` : ""}`);
    for (const [policy, decide] of Object.entries(POLICIES)) {
      // Not extracted counts as wrong, for every policy alike.
      const wrong = rows.filter((row) => row.model === undefined || decide(row.signals, row.model) !== row.entry.expected);
      const right = rows.length - wrong.length;
      console.log(`  ${String(right).padStart(2)}/${rows.length}  ${policy}`);
      for (const row of wrong.filter((candidate) => candidate.model !== undefined)) console.log(`         wrong: ${row.entry.note} (expected ${row.entry.expected}; line ${row.signals.line ?? "-"}, heading ${row.signals.heading ?? "-"}, model ${row.model})`);
      if (policy === IN_USE && right < (FLOOR[name] ?? 0)) {
        belowFloor = true;
        console.log(`         BELOW THE FLOOR of ${FLOOR[name]} for this set`);
      }
    }
  }
  if (belowFloor) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
