import { describe, expect, it } from "vitest";
import {
  addFlashcard, addQuestion, BuilderError, deleteFlashcard, deleteQuestion, moveQuestion, patchBrief, patchFlashcard,
  patchQuestion, reconcile, reorderFlashcards, reorderQuestions, setPinned, type BuilderState,
} from "../src/builder/operations";
import { mergeRegeneratedQuestions, undoRegeneratedQuestions } from "../src/builder/regenerate-merge";
import type { DraftQuestion } from "../src/generation/questions";
import type { Kit, Question } from "../src/kit/schema";
import { validateKit } from "../src/kit/validate";
import { appendixAKit } from "./support/kits";

const q = (id: string, category: Question["category"], requirementId: string, extra: Partial<Question> = {}): Question => ({
  id, category, requirement_ids: [requirementId], prompt: `Prompt ${id}`, answer_outline: `Outline ${id}`, difficulty: 2, origin: "generated", ...extra,
});

/** t1 t2 b1 t3 b2: two categories interleaved, so tests can see that one category's change leaves the other alone. */
function startState(): BuilderState {
  const base = appendixAKit();
  const kit: Kit = reconcile({
    ...base,
    role: {
      ...base.role,
      requirements: [
        { id: "r1", text: "Node.js", kind: "technical", priority: "must" },
        { id: "r2", text: "Mentoring", kind: "behavioural", priority: "must" },
        { id: "r3", text: "Kubernetes", kind: "technical", priority: "nice" },
      ],
    },
    questions: [q("q1", "technical", "r1"), q("q2", "technical", "r1"), q("q3", "behavioural", "r2"), q("q4", "technical", "r3"), q("q5", "behavioural", "r2")],
    flashcards: [
      { id: "f1", front: "F1", back: "B1", requirement_ids: ["r1"], origin: "generated" },
      { id: "f2", front: "F2", back: "B2", requirement_ids: ["r2"], origin: "generated" },
    ],
  });
  return { kit, counters: { q: 5, f: 2 } };
}

const ids = (state: BuilderState) => state.kit.questions.map((question) => question.id);
/** The order a user sees: questions are shown grouped by category. */
const order = (state: BuilderState, category: Question["category"]) => state.kit.questions.filter((x) => x.category === category).map((x) => x.id);
const draft = (prompt: string, requirementId = "r1"): DraftQuestion => ({ category: "technical", requirement_ids: [requirementId], prompt, answer_outline: "New outline", difficulty: 3, origin: "generated" });
const expectValid = (state: BuilderState) => expect(validateKit(state.kit)).toMatchObject({ ok: true });

describe("editing", () => {
  it("marks a question edited when its content changes, and leaves every other question identical", () => {
    const before = startState();
    const after = patchQuestion(before, "q2", { prompt: "My wording" });
    expect(after.kit.questions[1]).toMatchObject({ id: "q2", prompt: "My wording", edited: true, origin: "generated" });
    expect(after.kit.questions.filter((x) => x.id !== "q2")).toEqual(before.kit.questions.filter((x) => x.id !== "q2"));
  });

  it("does not mark anything edited when nothing actually changed", () => {
    const before = startState();
    expect(patchQuestion(before, "q2", { prompt: "Prompt q2" })).toBe(before);
    expect(patchFlashcard(before, "f1", { front: "F1" })).toBe(before);
    expect(patchBrief(before, { summary: before.kit.company_brief.summary })).toBe(before);
  });

  it("edits flashcards and the brief the same way", () => {
    const state = patchBrief(patchFlashcard(startState(), "f1", { back: "Better answer" }), { what_they_do: "My notes" });
    expect(state.kit.flashcards[0]).toMatchObject({ back: "Better answer", edited: true });
    expect(state.kit.company_brief).toMatchObject({ what_they_do: "My notes", edited: true });
  });

  it("refuses an unknown item or an unknown requirement id", () => {
    expect(() => patchQuestion(startState(), "q99", { prompt: "x" })).toThrow(BuilderError);
    expect(() => patchQuestion(startState(), "q1", { requirement_ids: ["r99"] })).toThrow(/Unknown requirement/);
  });

  it("recomputes coverage when an edit changes which requirements a question covers", () => {
    const state = patchQuestion(startState(), "q4", { requirement_ids: ["r1"] });
    expect(state.kit.coverage.uncovered_requirement_ids).toEqual(["r3"]);
  });
});

describe("adding and deleting", () => {
  it("adds a user question at the end of its category with a fresh id, and schedules it", () => {
    const { state, id } = addQuestion(startState(), { category: "technical", prompt: "My own question", requirement_ids: ["r1"] });
    expect(id).toBe("q6");
    expect(ids(state)).toEqual(["q1", "q2", "q3", "q4", "q6", "q5"]);
    expect(state.kit.questions[4]).toMatchObject({ origin: "user", difficulty: 2 });
    expect(state.kit.schedule.days.flatMap((day) => day.question_ids)).toContain("q6");
    expectValid(state);
  });

  it("never reuses an id, even after the newest item was deleted", () => {
    const added = addQuestion(startState(), { category: "technical", prompt: "First" });
    const readded = addQuestion(deleteQuestion(added.state, added.id), { category: "technical", prompt: "Second" });
    expect([added.id, readded.id]).toEqual(["q6", "q7"]);

    const card = addFlashcard(startState(), { front: "Mine" });
    expect(addFlashcard(deleteFlashcard(card.state, card.id), { front: "Again" }).id).toBe("f4");
  });

  it("removes a deleted question from the schedule and updates coverage", () => {
    const state = deleteQuestion(startState(), "q4");
    expect(state.kit.schedule.days.flatMap((day) => day.question_ids)).not.toContain("q4");
    expect(state.kit.coverage.uncovered_requirement_ids).toEqual(["r3"]);
    expect(state.kit.schedule.days).toHaveLength(state.kit.schedule.days_available);
    expectValid(state);
  });
});

describe("reordering and moving", () => {
  it("reorders one category without moving any other category's questions", () => {
    const state = reorderQuestions(startState(), "technical", ["q4", "q1", "q2"]);
    expect(ids(state)).toEqual(["q4", "q1", "q3", "q2", "q5"]);
    expectValid(state);
  });

  it.each([[["q1", "q2"]], [["q1", "q2", "q2"]], [["q1", "q2", "q3"]], [["q1", "q2", "q4", "q9"]]])("refuses an order that is not exactly the category's questions: %j", (order) => {
    expect(() => reorderQuestions(startState(), "technical", order)).toThrow(/exactly/);
  });

  it("moves a question to another category at the requested position, and pins it", () => {
    const state = moveQuestion(startState(), "q1", "behavioural", 1);
    expect(order(state, "behavioural")).toEqual(["q3", "q1", "q5"]);
    expect(order(state, "technical")).toEqual(["q2", "q4"]);
    expect(state.kit.questions.find((x) => x.id === "q1")).toMatchObject({ category: "behavioural", pinned: true });
    expectValid(state);
  });

  it("moves within a category without pinning", () => {
    const state = moveQuestion(startState(), "q4", "technical", 0);
    expect(order(state, "technical")).toEqual(["q4", "q1", "q2"]);
    expect(order(state, "behavioural")).toEqual(["q3", "q5"]);
    expect(state.kit.questions.find((x) => x.id === "q4")!.pinned).toBeUndefined();
  });

  it("moves into an empty category", () => {
    const state = moveQuestion(startState(), "q3", "system-design", 0);
    expect(state.kit.questions.find((x) => x.id === "q3")).toMatchObject({ category: "system-design", pinned: true });
    expectValid(state);
  });

  it("reorders flashcards", () => {
    expect(reorderFlashcards(startState(), ["f2", "f1"]).kit.flashcards.map((f) => f.id)).toEqual(["f2", "f1"]);
    expect(() => reorderFlashcards(startState(), ["f2"])).toThrow(BuilderError);
  });
});

describe("regenerating a category", () => {
  it("replaces generated questions and keeps edited, pinned and user-written ones in place", () => {
    let state = patchQuestion(startState(), "q1", { prompt: "I rewrote this" });
    state = setPinned(state, { kind: "question", id: "q4" }, true);
    state = addQuestion(state, { category: "technical", prompt: "My own", requirement_ids: ["r1"] }).state; // q6

    const result = mergeRegeneratedQuestions(state, "technical", [draft("New A"), draft("New B", "r3")]);

    // q2 was the only replaceable technical question; New A takes its slot, New B goes after the category's last question.
    expect(ids(result.state)).toEqual(["q1", "q7", "q3", "q4", "q6", "q8", "q5"]);
    expect(result.removed.map((x) => x.id)).toEqual(["q2"]);
    expect(result.addedIds).toEqual(["q7", "q8"]);
    expect(result.state.kit.questions[0]).toMatchObject({ prompt: "I rewrote this", edited: true });
    expect(result.state.kit.questions[3]).toMatchObject({ id: "q4", pinned: true });
    expect(result.state.kit.questions[4]).toMatchObject({ id: "q6", origin: "user" });
    expectValid(result.state);
  });

  it("leaves every other section byte-identical", () => {
    const before = patchFlashcard(patchBrief(startState(), { summary: "My summary" }), "f2", { front: "Mine" });
    const after = mergeRegeneratedQuestions(before, "technical", [draft("New A")]).state;

    expect(after.kit.questions.filter((x) => x.category !== "technical")).toEqual(before.kit.questions.filter((x) => x.category !== "technical"));
    for (const section of ["company_brief", "flashcards", "role", "source", "notes", "hiring_stages"] as const) {
      expect(JSON.stringify(after.kit[section])).toBe(JSON.stringify(before.kit[section]));
    }
  });

  it("protects a question that was edited while the regeneration was running", () => {
    const whenGenerationStarted = startState();
    const drafts = [draft("New A"), draft("New B"), draft("New C", "r3")];
    // ...the model takes ten seconds; meanwhile the user edits q2.
    const now = patchQuestion(whenGenerationStarted, "q2", { answer_outline: "Typed during regeneration" });

    const result = mergeRegeneratedQuestions(now, "technical", drafts);
    expect(result.state.kit.questions.find((x) => x.id === "q2")).toMatchObject({ answer_outline: "Typed during regeneration" });
    expect(result.removed.map((x) => x.id)).toEqual(["q1", "q4"]);
  });

  it("drops a new question that repeats one the user kept", () => {
    const state = setPinned(startState(), { kind: "question", id: "q1" }, true);
    const result = mergeRegeneratedQuestions(state, "technical", [draft("  prompt Q1 "), draft("Different")]);
    expect(result.state.kit.questions.filter((x) => x.prompt.trim().toLowerCase() === "prompt q1")).toHaveLength(1);
  });

  it("writes a fallback question if the swap left a must-have uncovered", () => {
    const result = mergeRegeneratedQuestions(startState(), "technical", [draft("Only about Kubernetes", "r3")]);
    const fallback = result.state.kit.questions.filter((x) => x.origin === "fallback");
    expect(fallback.map((x) => x.requirement_ids)).toEqual([["r1"]]);
    expect(result.state.kit.coverage.uncovered_requirement_ids).toEqual([]);
    expectValid(result.state);
  });

  it("keeps protected questions even when the model returns nothing", () => {
    const state = setPinned(startState(), { kind: "question", id: "q2" }, true);
    const result = mergeRegeneratedQuestions(state, "technical", []);
    expect(ids(result.state).filter((id) => ["q1", "q2", "q4"].includes(id))).toEqual(["q2"]);
    expectValid(result.state);
  });

  it("can be undone: removed questions come back with their ids, added ones go, and anything the user has since adopted stays", () => {
    const before = startState();
    const merged = mergeRegeneratedQuestions(before, "technical", [draft("New A"), draft("New B", "r3"), draft("New C")]);
    const adopted = patchQuestion(merged.state, merged.addedIds[0]!, { prompt: "I like this one, reworded" });

    const undone = undoRegeneratedQuestions(adopted, "technical", merged.removed, merged.addedIds);
    expect(new Set(ids(undone))).toEqual(new Set(["q1", "q2", "q3", "q4", "q5", merged.addedIds[0]]));
    expect(undone.kit.questions.filter((x) => x.category === "behavioural")).toEqual(before.kit.questions.filter((x) => x.category === "behavioural"));
    expect(undone.counters.q).toBe(merged.state.counters.q);
    expectValid(undone);
  });
});
