import type { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "../src/builder/operations";
import type { Flashcard, Kit, Question } from "../src/kit/schema";
import { validateKit } from "../src/kit/validate";
import { kitRepository } from "../src/persistence/kits";
import { nextSession, practiceCoverage, rate, weakSpots, type CardProgress, type Progress } from "../src/practice/leitner";
import { allocateSchedule } from "../src/scheduling/allocate";
import { startTestApi, type TestApi } from "./support/api";
import { appendixAKit } from "./support/kits";

const card = (id: string, requirementId: string): Flashcard => ({ id, front: `Front ${id}`, back: "Back", requirement_ids: [requirementId], origin: "generated" });
const question = (id: string, requirementId: string, difficulty = 2): Question => ({ id, category: "technical", requirement_ids: [requirementId], prompt: id, answer_outline: "", difficulty, origin: "generated" });
const seen = (box: number, lastSeenAt: string, lastConfidence: CardProgress["lastConfidence"] = 3): CardProgress => ({ box, seen: 1, lastConfidence, lastSeenAt });

function practiceKit(): Kit {
  const base = appendixAKit();
  return reconcile({
    ...base,
    role: {
      ...base.role,
      requirements: [
        { id: "r1", text: "Node.js", kind: "technical", priority: "must" },
        { id: "r2", text: "PostgreSQL", kind: "technical", priority: "must" },
        { id: "r3", text: "Kubernetes", kind: "technical", priority: "nice" },
      ],
    },
    questions: [question("q1", "r1", 3), question("q2", "r1", 1), question("q3", "r2", 2), question("q4", "r3", 2), question("q5", "r2", 3), question("q6", "r3", 1)],
    flashcards: [card("f1", "r1"), card("f2", "r1"), card("f3", "r2"), card("f4", "r3"), card("f5", "r3")],
    schedule: { days_available: 6, days: [] },
  });
}

const NOW = new Date("2026-09-19T10:00:00Z");

describe("rate", () => {
  it.each([
    [undefined, 1, 1], [undefined, 2, 1], [undefined, 3, 2], [undefined, 4, 3],
    [3, 1, 1], [3, 2, 2], [3, 3, 4], [3, 4, 5], [5, 4, 5], [1, 2, 1],
  ] as const)("from box %s with confidence %i goes to box %i", (box, confidence, expected) => {
    const result = rate(box === undefined ? undefined : seen(box, "2026-09-18T10:00:00Z"), confidence, NOW);
    expect(result).toMatchObject({ box: expected, lastConfidence: confidence, lastSeenAt: NOW.toISOString() });
  });

  it("counts how often a card has been seen", () => {
    expect(rate(rate(undefined, 3, NOW), 3, NOW).seen).toBe(2);
  });
});

describe("nextSession", () => {
  const cards = practiceKit().flashcards;

  it("starts with the cards in kit order when nothing has been practised", () => {
    expect(nextSession(cards, {}, 3).map((c) => c.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("puts unseen cards first, then the lowest box, then the card seen longest ago", () => {
    const progress: Progress = {
      f1: seen(4, "2026-09-10T00:00:00Z"),
      f2: seen(1, "2026-09-18T00:00:00Z"),
      f4: seen(1, "2026-09-12T00:00:00Z"),
      f5: seen(2, "2026-09-11T00:00:00Z"),
    };
    expect(nextSession(cards, progress).map((c) => c.id)).toEqual(["f3", "f4", "f2", "f5", "f1"]);
  });

  it("ignores progress for cards that no longer exist", () => {
    expect(nextSession(cards, { gone: seen(1, "2026-09-01T00:00:00Z") }, 2).map((c) => c.id)).toEqual(["f1", "f2"]);
  });
});

describe("practiceCoverage", () => {
  it("counts covered, not covered and mastered", () => {
    const progress: Progress = { f1: seen(5, "x"), f2: seen(4, "x"), f3: seen(2, "x"), gone: seen(5, "x") };
    expect(practiceCoverage(practiceKit().flashcards, progress)).toEqual({ total: 5, covered: 3, notCovered: 2, mastered: 2, boxes: [0, 1, 0, 1, 1] });
  });
});

describe("weakSpots", () => {
  it("maps struggling cards back to requirements, must-haves first, with the questions to revisit", () => {
    const progress: Progress = { f1: seen(1, "x", 1), f2: seen(2, "x", 2), f3: seen(5, "x", 4), f4: seen(1, "x", 1), f5: seen(1, "x", 1) };
    const spots = weakSpots(practiceKit(), progress);
    expect(spots.map((s) => [s.requirement.id, s.weakCards, s.questionIds])).toEqual([
      ["r1", 2, ["q1", "q2"]],
      ["r3", 2, ["q4", "q6"]],
    ]);
  });

  it("does not call a requirement weak just because its cards have not been seen", () => {
    expect(weakSpots(practiceKit(), {})).toEqual([]);
  });
});

describe("re-planning the schedule", () => {
  const kit = practiceKit();
  const scheduled = (days: Array<{ question_ids: string[] }>) => days.flatMap((d) => d.question_ids);

  it("keeps the days already done and deals everything else out again, weak spots first", () => {
    const replanned = allocateSchedule({ days: 6, questions: kit.questions, requirements: kit.role.requirements, replan: { from_day: 3, focus_question_ids: ["q4", "q6"] }, previousDays: kit.schedule.days });

    expect(replanned.days).toHaveLength(6);
    expect(replanned.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(replanned.days.slice(0, 2)).toEqual(kit.schedule.days.slice(0, 2));
    expect(replanned.days[2]!.question_ids).toEqual(["q4", "q6"]);
    expect(new Set(scheduled(replanned.days.slice(2)))).toEqual(new Set(["q1", "q2", "q3", "q4", "q5", "q6"]));
    expect(replanned.replan).toEqual({ from_day: 3, focus_question_ids: ["q4", "q6"] });
    expect(validateKit({ ...kit, schedule: replanned })).toMatchObject({ ok: true });
  });

  it("survives a later edit to the kit, and forgets focus questions that were deleted", () => {
    const replanned = reconcile({ ...kit, schedule: { ...kit.schedule, replan: { from_day: 3, focus_question_ids: ["q4", "q6"] } } });
    const afterDelete = reconcile({ ...replanned, questions: replanned.questions.filter((q) => q.id !== "q6") });

    expect(afterDelete.schedule.replan).toEqual({ from_day: 3, focus_question_ids: ["q4"] });
    expect(afterDelete.schedule.days[2]!.question_ids[0]).toBe("q4");
    expect(scheduled(afterDelete.schedule.days)).not.toContain("q6");
    expect(validateKit(afterDelete)).toMatchObject({ ok: true });
  });

  it("re-plans the whole schedule when asked from day 1, and clamps a day past the end", () => {
    const fromStart = allocateSchedule({ days: 3, questions: kit.questions, requirements: kit.role.requirements, replan: { from_day: 1, focus_question_ids: ["q6"] }, previousDays: [] });
    expect(fromStart.days[0]!.question_ids[0]).toBe("q6");
    const pastEnd = allocateSchedule({ days: 3, questions: kit.questions, requirements: kit.role.requirements, replan: { from_day: 9, focus_question_ids: ["q6"] }, previousDays: kit.schedule.days });
    expect(pastEnd.days).toHaveLength(3);
    expect(pastEnd.replan!.from_day).toBe(3);
  });
});

describe("practice API", () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startTestApi();
  }, 120_000);
  afterAll(() => api.close());
  beforeEach(() => api.reset());

  async function adaWithKit() {
    const ada = await api.signedIn("ada@example.com");
    const userId = (await api.db.users.findOne({ email: "ada@example.com" }))!._id as ObjectId;
    const stored = await kitRepository(api.db).create(userId, practiceKit(), "fp");
    return { ada, base: `/api/kits/${stored.id}` };
  }

  it("serves a session, records confidence, and reorders the next session around it", async () => {
    const { ada, base } = await adaWithKit();
    const first = (await ada.get(`${base}/practice?size=3`).expect(200)).body;
    expect(first.session).toEqual(["f1", "f2", "f3"]);
    expect(first.coverage).toMatchObject({ total: 5, covered: 0, notCovered: 5 });

    await ada.post(`${base}/practice/ratings`).send({ flashcard_id: "f1", confidence: 4 }).expect(200);
    await ada.post(`${base}/practice/ratings`).send({ flashcard_id: "f2", confidence: 1 }).expect(200);
    const rated = (await ada.post(`${base}/practice/ratings`).send({ flashcard_id: "f3", confidence: 3 }).expect(200)).body;

    expect(rated.coverage).toMatchObject({ covered: 3, notCovered: 2, mastered: 0 });
    expect(rated.session).toEqual(["f4", "f5", "f2", "f3", "f1"]);
    expect(rated.weak_spots.map((s: { requirement: { id: string } }) => s.requirement.id)).toEqual(["r1"]);
    expect(rated.progress.f1).toMatchObject({ box: 3, seen: 1, lastConfidence: 4 });

    // Progress is still there on the next visit.
    expect((await ada.get(`${base}/practice`)).body.coverage.covered).toBe(3);
  });

  it("validates ratings", async () => {
    const { ada, base } = await adaWithKit();
    await ada.post(`${base}/practice/ratings`).send({ flashcard_id: "f1", confidence: 5 }).expect(400);
    await ada.post(`${base}/practice/ratings`).send({ flashcard_id: "f99", confidence: 2 }).expect(404);
  });

  it("re-plans the remaining days around weak spots, and regenerating the schedule goes back to the default plan", async () => {
    const { ada, base } = await adaWithKit();
    expect((await ada.post(`${base}/practice/replan`).send({ from_day: 2 }).expect(409)).body.error.code).toBe("NO_WEAK_SPOTS");

    await ada.post(`${base}/practice/ratings`).send({ flashcard_id: "f4", confidence: 1 });
    const replanned = (await ada.post(`${base}/practice/replan`).send({ from_day: 2 }).expect(200)).body.kit;
    expect(replanned.schedule.replan).toEqual({ from_day: 2, focus_question_ids: ["q4", "q6"] });
    expect(replanned.schedule.days[1].question_ids.slice(0, 2)).toEqual(["q4", "q6"]);
    expect(replanned.schedule.days).toHaveLength(6);
    await ada.post(`${base}/practice/replan`).send({ from_day: 7 }).expect(400);

    const reset = (await ada.post(`${base}/regenerate`).send({ section: "schedule" }).expect(200)).body.kit;
    expect(reset.schedule.replan).toBeUndefined();
  });

  it("resets progress, and hides practice from other users", async () => {
    const { ada, base } = await adaWithKit();
    await ada.post(`${base}/practice/ratings`).send({ flashcard_id: "f1", confidence: 3 });
    expect((await ada.delete(`${base}/practice`).expect(200)).body.coverage.covered).toBe(0);

    const bob = await api.signedIn("bob@example.com");
    await bob.get(`${base}/practice`).expect(404);
    await bob.post(`${base}/practice/ratings`).send({ flashcard_id: "f1", confidence: 3 }).expect(404);
  });
});
