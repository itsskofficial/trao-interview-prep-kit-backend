import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decidePriority } from "../src/extraction/priority";

interface Case {
  jd: string;
  evidence: string;
  expected: "must" | "nice" | "defer";
  note: string;
}

const { cases, heldOut } = JSON.parse(readFileSync("fixtures/priority-cases.json", "utf8")) as { cases: Case[]; heldOut: Case[] };

/** What the wording alone decides: the answer that comes out whichever label the model gives, or "defer" when the model's label is what comes out. */
function ruleAlone(entry: Case): "must" | "nice" | "defer" {
  const givenMust = decidePriority(entry.jd, entry.evidence, "must");
  const givenNice = decidePriority(entry.jd, entry.evidence, "nice");
  return givenMust === givenNice ? givenMust : "defer";
}

/**
 * The rule overrules the model, so the thing that must never happen is the rule speaking and being wrong.
 * Staying silent is allowed: the model then decides, and `npm run measure:priority` measures how well it does.
 */
const wronglyOverruled = (set: Case[]) => set.filter((entry) => ruleAlone(entry) !== "defer" && ruleAlone(entry) !== entry.expected).map((entry) => entry.note);

describe("priority by wording, measured", () => {
  it("never overrules the model wrongly on the cases it was tuned on", () => {
    expect(wronglyOverruled(cases)).toEqual([]);
  });

  it("never overrules the model wrongly on cases it has never been tuned on", () => {
    expect(wronglyOverruled(heldOut)).toEqual([]);
  });

  it("stays silent where the posting gives no signal", () => {
    for (const entry of [...cases, ...heldOut].filter((candidate) => candidate.expected === "defer")) expect(ruleAlone(entry), entry.note).toBe("defer");
  });

  it("still speaks where the wording is explicit, so a lazy model cannot flatten a posting", () => {
    const explicit = cases.filter((entry) => entry.expected !== "defer" && ruleAlone(entry) !== "defer");
    // Most of the tuned set is explicit wording; if this collapses, the rule has stopped doing its job.
    expect(explicit.length).toBeGreaterThanOrEqual(25);
  });
});
