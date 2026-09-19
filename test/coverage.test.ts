import { describe, expect, it, vi } from "vitest";
import { closeCoverageGaps, fallbackQuestion, findUncovered, MAX_COVERAGE_PASSES } from "../src/coverage/coverage";
import type { DraftQuestion } from "../src/generation/questions";
import type { Requirement } from "../src/kit/schema";

const requirements: Requirement[] = [
  { id: "r1", text: "Node.js", kind: "technical", priority: "must" },
  { id: "r2", text: "PostgreSQL", kind: "technical", priority: "must" },
  { id: "r3", text: "Mentoring", kind: "behavioural", priority: "must" },
  { id: "r4", text: "Kubernetes", kind: "technical", priority: "nice" },
];

const covering = (...ids: string[]): DraftQuestion => ({
  requirement_ids: ids, category: "technical", prompt: `About ${ids.join(",")}`, answer_outline: "", difficulty: 2, origin: "generated",
});
const ids = (list: Requirement[]) => list.map((r) => r.id);

describe("findUncovered", () => {
  it("returns the requirements no question references", () => {
    expect(ids(findUncovered(requirements, [covering("r1"), covering("r3", "r1")]))).toEqual(["r2", "r4"]);
  });

  it("returns nothing when everything is covered, and everything when there are no questions", () => {
    expect(findUncovered(requirements, [covering("r1", "r2", "r3", "r4")])).toEqual([]);
    expect(ids(findUncovered(requirements, []))).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("ignores references to requirements that do not exist", () => {
    expect(ids(findUncovered(requirements, [covering("r99")]))).toEqual(["r1", "r2", "r3", "r4"]);
  });
});

describe("closeCoverageGaps", () => {
  it("makes no model call when the first draft covers everything", async () => {
    const generate = vi.fn();
    const result = await closeCoverageGaps(requirements, [covering("r1", "r2", "r3", "r4")], generate);
    expect(generate).not.toHaveBeenCalled();
    expect(result).toEqual({ added: [], passes: 1, uncovered: [] });
  });

  it("asks only for the gaps, and a second check confirms they are closed", async () => {
    const generate = vi.fn(async (gaps: Requirement[]) => gaps.map((gap) => covering(gap.id)));
    const result = await closeCoverageGaps(requirements, [covering("r1"), covering("r3")], generate);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(ids(generate.mock.calls[0]![0])).toEqual(["r2", "r4"]);
    expect(result.passes).toBe(2);
    expect(result.uncovered).toEqual([]);
    expect(result.added.map((q) => q.requirement_ids)).toEqual([["r2"], ["r4"]]);
  });

  it("keeps going while passes make progress, up to the limit", async () => {
    // The model closes one gap per call.
    const generate = vi.fn(async (gaps: Requirement[]) => [covering(gaps[0]!.id)]);
    const result = await closeCoverageGaps(requirements, [], generate);

    expect(generate).toHaveBeenCalledTimes(MAX_COVERAGE_PASSES - 1);
    expect(result.passes).toBe(MAX_COVERAGE_PASSES);
    expect(findUncovered(requirements.filter((r) => r.priority === "must"), result.added)).toEqual([]);
  });

  it("stops early when a pass closes nothing, and writes fallback questions for the must-haves", async () => {
    const generate = vi.fn(async () => []);
    const result = await closeCoverageGaps(requirements, [covering("r1")], generate);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.passes).toBe(2);
    expect(result.added.map((q) => [q.requirement_ids, q.origin])).toEqual([[["r2"], "fallback"], [["r3"], "fallback"]]);
  });

  it("reports an uncovered nice-to-have instead of forcing a question, and tries it only once", async () => {
    const generate = vi.fn(async (gaps: Requirement[]) => gaps.filter((g) => g.id === "r2").map((g) => covering(g.id)));
    const result = await closeCoverageGaps(requirements, [covering("r1"), covering("r3")], generate);

    expect(ids(result.uncovered)).toEqual(["r4"]);
    expect(result.added.every((q) => q.origin === "generated")).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("treats a failing model as a pass that closed nothing", async () => {
    const generate = vi.fn(async () => { throw new Error("model down"); });
    const result = await closeCoverageGaps(requirements, [], generate);
    expect(result.added.map((q) => q.origin)).toEqual(["fallback", "fallback", "fallback"]);
    expect(ids(result.uncovered)).toEqual(["r4"]);
  });

  it("never leaves a must-have uncovered, whatever the model does", async () => {
    for (const generate of [async () => [], async () => [covering("r99")], async () => { throw new Error("x"); }]) {
      const { added, uncovered } = await closeCoverageGaps(requirements, [], generate);
      expect(uncovered.some((r) => r.priority === "must")).toBe(false);
      expect(findUncovered(requirements, added).some((r) => r.priority === "must")).toBe(false);
    }
  });
});

describe("fallbackQuestion", () => {
  it("quotes the requirement and files it under the right category", () => {
    expect(fallbackQuestion(requirements[2]!)).toMatchObject({ requirement_ids: ["r3"], category: "behavioural", origin: "fallback" });
    expect(fallbackQuestion(requirements[0]!).prompt).toContain('"Node.js"');
  });
});
