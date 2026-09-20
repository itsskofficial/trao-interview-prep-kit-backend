import type { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "../src/builder/operations";
import type { Kit, Question } from "../src/kit/schema";
import { validateKit } from "../src/kit/validate";
import { kitRepository } from "../src/persistence/kits";
import { startTestApi, type TestApi } from "./support/api";
import { appendixAKit } from "./support/kits";
import { routedModel } from "./support/model";

const q = (id: string, category: Question["category"], requirementId: string): Question => ({
  id, category, requirement_ids: [requirementId], prompt: `Prompt ${id}`, answer_outline: `Outline ${id}`, difficulty: 2, origin: "generated",
});

function seedKit(): Kit {
  const base = appendixAKit();
  return reconcile({
    ...base,
    company_brief: { ...base.company_brief, origin: "generated" },
    role: {
      ...base.role,
      requirements: [
        { id: "r1", text: "Node.js", kind: "technical", priority: "must" },
        { id: "r2", text: "Mentoring", kind: "behavioural", priority: "must" },
        { id: "r3", text: "Kubernetes", kind: "technical", priority: "nice" },
      ],
    },
    questions: [q("q1", "technical", "r1"), q("q2", "technical", "r1"), q("q3", "behavioural", "r2"), q("q4", "technical", "r3")],
    flashcards: [
      { id: "f1", front: "F1", back: "B1", requirement_ids: ["r1"], origin: "generated" },
      { id: "f2", front: "F2", back: "B2", requirement_ids: ["r2"], origin: "generated" },
    ],
  });
}

let api: TestApi;
/** Lets a test hold the model's answer back until it says go, the way a real call takes seconds. */
let release: () => void = () => undefined;
let hold = false;
let technicalAnswer: object = {};

const freshTechnical = {
  questions: [
    { requirement_ids: ["r1"], prompt: "New Node question", answer_outline: "New", difficulty: 3 },
    { requirement_ids: ["r3"], prompt: "New Kubernetes question", answer_outline: "New", difficulty: 1 },
  ],
};

beforeAll(async () => {
  const routed = routedModel({ technical: () => technicalAnswer as object });
  const waitIfHeld = () => (hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve());
  api = await startTestApi({}, { llm: { generate: (request) => waitIfHeld().then(() => routed.llm.generate(request)) } });
}, 120_000);
afterAll(() => api.close());
beforeEach(async () => {
  hold = false;
  technicalAnswer = freshTechnical;
  await api.reset();
});

async function adaWithKit() {
  const ada = await api.signedIn("ada@example.com");
  const userId = (await api.db.users.findOne({ email: "ada@example.com" }))!._id as ObjectId;
  const stored = await kitRepository(api.db).create(userId, seedKit(), "fp");
  return { ada, id: stored.id, base: `/api/kits/${stored.id}` };
}

const questionIds = (kit: Kit, category?: string) => kit.questions.filter((x) => !category || x.category === category).map((x) => x.id);

describe("per-item changes", () => {
  it("edits one question and marks it edited", async () => {
    const { ada, base } = await adaWithKit();
    const { body } = await ada.patch(`${base}/questions/q2`).send({ prompt: "My wording" }).expect(200);
    expect(body.kit.questions[1]).toMatchObject({ id: "q2", prompt: "My wording", edited: true });
    expect(body.version).toBe(2);
  });

  it("adds, moves, reorders, pins and deletes, keeping the kit valid throughout", async () => {
    const { ada, base } = await adaWithKit();
    const added = await ada.post(`${base}/questions`).send({ category: "technical", prompt: "My own question", requirement_ids: ["r1"] }).expect(201);
    expect(added.body.createdId).toBe("q5");

    await ada.post(`${base}/questions/q1/move`).send({ category: "behavioural", index: 0 }).expect(200);
    await ada.put(`${base}/questions/order`).send({ category: "technical", ids: ["q5", "q4", "q2"] }).expect(200);
    await ada.put(`${base}/pins`).send({ kind: "question", id: "q4", pinned: true }).expect(200);
    const { body } = await ada.delete(`${base}/questions/q2`).expect(200);

    expect(questionIds(body.kit, "technical")).toEqual(["q5", "q4"]);
    expect(questionIds(body.kit, "behavioural")).toEqual(["q1", "q3"]);
    expect(body.kit.questions.find((x: Question) => x.id === "q1")).toMatchObject({ pinned: true });
    expect(body.kit.schedule.days.flatMap((d: { question_ids: string[] }) => d.question_ids)).not.toContain("q2");
    expect(validateKit(body.kit)).toMatchObject({ ok: true });
  });

  it("edits flashcards and the brief, adds and deletes cards", async () => {
    const { ada, base } = await adaWithKit();
    await ada.patch(`${base}/flashcards/f1`).send({ back: "Better" }).expect(200);
    await ada.patch(`${base}/brief`).send({ summary: "My summary" }).expect(200);
    const added = await ada.post(`${base}/flashcards`).send({ front: "Mine" }).expect(201);
    await ada.put(`${base}/flashcards/order`).send({ ids: ["f3", "f1", "f2"] }).expect(200);
    const { body } = await ada.delete(`${base}/flashcards/f2`).expect(200);

    expect(added.body.createdId).toBe("f3");
    expect(body.kit.flashcards.map((f: { id: string }) => f.id)).toEqual(["f3", "f1"]);
    expect(body.kit.flashcards[1]).toMatchObject({ back: "Better", edited: true });
    expect(body.kit.company_brief).toMatchObject({ summary: "My summary", edited: true });
  });

  it("answers with useful errors", async () => {
    const { ada, base } = await adaWithKit();
    expect((await ada.patch(`${base}/questions/q99`).send({ prompt: "x" }).expect(404)).body.error.code).toBe("NOT_FOUND");
    expect((await ada.patch(`${base}/questions/q1`).send({ prompt: "" }).expect(400)).body.error.details[0].field).toBe("prompt");
    expect((await ada.patch(`${base}/questions/q1`).send({}).expect(400)).body.error.code).toBe("VALIDATION_FAILED");
    expect((await ada.patch(`${base}/questions/q1`).send({ requirement_ids: ["r99"] }).expect(400)).body.error.code).toBe("INVALID_OPERATION");
    expect((await ada.put(`${base}/questions/order`).send({ category: "technical", ids: ["q1"] }).expect(400)).body.error.code).toBe("INVALID_OPERATION");
  });

  it("applies many changes sent at the same moment without losing any of them", async () => {
    const { ada, base } = await adaWithKit();
    await Promise.all([
      ada.patch(`${base}/questions/q1`).send({ prompt: "One" }).expect(200),
      ada.patch(`${base}/questions/q2`).send({ prompt: "Two" }).expect(200),
      ada.patch(`${base}/questions/q3`).send({ prompt: "Three" }).expect(200),
      ada.patch(`${base}/flashcards/f1`).send({ front: "Card" }).expect(200),
      ada.patch(`${base}/brief`).send({ summary: "Brief" }).expect(200),
    ]);
    const { kit, version } = (await ada.get(base)).body;
    expect(kit.questions.slice(0, 3).map((x: Question) => x.prompt)).toEqual(["One", "Two", "Three"]);
    expect(kit.flashcards[0].front).toBe("Card");
    expect(kit.company_brief.summary).toBe("Brief");
    expect(version).toBe(6);
  });

  it("does not let another user change the kit", async () => {
    const { base } = await adaWithKit();
    const bob = await api.signedIn("bob@example.com");
    await bob.patch(`${base}/questions/q1`).send({ prompt: "Hijacked" }).expect(404);
    await bob.post(`${base}/regenerate`).send({ section: "schedule" }).expect(404);
  });
});

describe("regenerating a section", () => {
  it("answers 202 at once, shows the section as regenerating, then replaces only what may be replaced", async () => {
    const { ada, base } = await adaWithKit();
    await ada.patch(`${base}/questions/q1`).send({ prompt: "I rewrote this" });
    await ada.put(`${base}/pins`).send({ kind: "question", id: "q4", pinned: true });

    hold = true;
    const started = await ada.post(`${base}/regenerate`).send({ section: "questions", category: "technical" }).expect(202);
    expect(started.body.regeneration).toMatchObject({ section: "questions", category: "technical", status: "running" });
    expect((await ada.post(`${base}/regenerate`).send({ section: "questions", category: "behavioural" }).expect(409)).body.error.code).toBe("ALREADY_REGENERATING");

    hold = false;
    release();
    await api.regenerator.idle();

    const { kit, regeneration, undoable } = (await ada.get(base)).body;
    expect(regeneration).toBeNull();
    expect(undoable).toEqual({ section: "questions", category: "technical" });
    expect(questionIds(kit, "technical")).toEqual(["q1", "q5", "q4", "q6"]);
    expect(kit.questions.find((x: Question) => x.id === "q1").prompt).toBe("I rewrote this");
    expect(questionIds(kit, "behavioural")).toEqual(["q3"]);
    expect(validateKit(kit)).toMatchObject({ ok: true });
  });

  it("does not add a regenerated question that repeats one the user is keeping", async () => {
    const { ada, base } = await adaWithKit();
    await ada.patch(`${base}/questions/q1`).send({ prompt: "How would you debug a memory leak in a Node.js service?" });
    technicalAnswer = {
      questions: [
        { requirement_ids: ["r1"], prompt: "How would you debug a memory leak in a Node.js service in production?", answer_outline: "Again", difficulty: 2 },
        { requirement_ids: ["r3"], prompt: "How does Kubernetes decide where to schedule a pod?", answer_outline: "New", difficulty: 2 },
      ],
    };
    await ada.post(`${base}/regenerate`).send({ section: "questions", category: "technical" }).expect(202);
    await api.regenerator.idle();

    const { kit } = (await ada.get(base)).body;
    const prompts = kit.questions.filter((x: Question) => x.category === "technical").map((x: Question) => x.prompt);
    expect(prompts).toEqual(["How would you debug a memory leak in a Node.js service?", "How does Kubernetes decide where to schedule a pod?"]);
  });

  it("replaces nothing, and says why, when the model only repeats what is being kept", async () => {
    const { ada, base } = await adaWithKit();
    await ada.patch(`${base}/questions/q1`).send({ prompt: "How would you debug a memory leak in a Node.js service?" });
    technicalAnswer = { questions: [{ requirement_ids: ["r1"], prompt: "How would you debug a memory leak in a Node.js service today?", answer_outline: "Again", difficulty: 2 }] };
    await ada.post(`${base}/regenerate`).send({ section: "questions", category: "technical" }).expect(202);
    await api.regenerator.idle();

    const { kit, regeneration } = (await ada.get(base)).body;
    expect(regeneration).toMatchObject({ status: "failed", error: expect.stringContaining("only repeated questions you are keeping") });
    expect(questionIds(kit, "technical")).toEqual(["q1", "q2", "q4"]);
  });

  it("keeps an edit that arrives while the model is still thinking, even in the same category", async () => {
    const { ada, base } = await adaWithKit();
    hold = true;
    await ada.post(`${base}/regenerate`).send({ section: "questions", category: "technical" }).expect(202);

    // The regeneration is in flight. The user keeps working.
    await ada.patch(`${base}/questions/q2`).send({ answer_outline: "Typed during regeneration" }).expect(200);
    await ada.patch(`${base}/flashcards/f1`).send({ front: "Edited elsewhere" }).expect(200);
    await ada.post(`${base}/questions`).send({ category: "behavioural", prompt: "Added elsewhere" }).expect(201);

    hold = false;
    release();
    await api.regenerator.idle();

    const { kit } = (await ada.get(base)).body;
    expect(kit.questions.find((x: Question) => x.id === "q2")).toMatchObject({ answer_outline: "Typed during regeneration", edited: true });
    expect(kit.flashcards[0].front).toBe("Edited elsewhere");
    expect(kit.questions.some((x: Question) => x.prompt === "Added elsewhere")).toBe(true);
    expect(kit.questions.some((x: Question) => x.prompt === "New Node question")).toBe(true);
  });

  it("changes nothing when generation fails, and says why", async () => {
    const { ada, base } = await adaWithKit();
    const before = (await ada.get(base)).body.kit;
    technicalAnswer = { questions: [] };

    await ada.post(`${base}/regenerate`).send({ section: "questions", category: "technical" }).expect(202);
    await api.regenerator.idle();

    const after = (await ada.get(base)).body;
    expect(after.kit).toEqual(before);
    expect(after.regeneration).toMatchObject({ status: "failed", error: expect.stringContaining("existing ones were kept") });
    // A failed regeneration does not block the next attempt.
    technicalAnswer = freshTechnical;
    await ada.post(`${base}/regenerate`).send({ section: "questions", category: "technical" }).expect(202);
    await api.regenerator.idle();
  });

  it("can be undone", async () => {
    const { ada, base } = await adaWithKit();
    await ada.post(`${base}/regenerate`).send({ section: "questions", category: "technical" }).expect(202);
    await api.regenerator.idle();

    const { body } = await ada.post(`${base}/regenerate/undo`).expect(200);
    expect(new Set(questionIds(body.kit))).toEqual(new Set(["q1", "q2", "q3", "q4"]));
    expect(body.undoable).toBeNull();
    expect((await ada.post(`${base}/regenerate/undo`).expect(409)).body.error.code).toBe("NOTHING_TO_UNDO");

    const added = await ada.post(`${base}/questions`).send({ category: "technical", prompt: "After undo" }).expect(201);
    expect(added.body.createdId).toBe("q7"); // q5 and q6 were used by the regeneration and are never handed out again
  });

  it("recomputes the schedule instantly", async () => {
    const { ada, base } = await adaWithKit();
    const { body } = await ada.post(`${base}/regenerate`).send({ section: "schedule" }).expect(200);
    expect(body.regeneration).toBeNull();
    expect(body.kit.schedule.days).toHaveLength(2);
  });

  it("asks before replacing a brief the user edited, and replaces it only when told to", async () => {
    const { ada, base } = await adaWithKit();
    await ada.patch(`${base}/brief`).send({ summary: "My careful notes" });

    expect((await ada.post(`${base}/regenerate`).send({ section: "brief" }).expect(409)).body.error.code).toBe("BRIEF_PROTECTED");
    await ada.post(`${base}/regenerate`).send({ section: "brief", force: true }).expect(202);
    await api.regenerator.idle();

    const replaced = (await ada.get(base)).body;
    expect(replaced.kit.company_brief.summary).toContain("No information about");
    expect(replaced.undoable).toEqual({ section: "brief" });

    const undone = await ada.post(`${base}/regenerate/undo`).expect(200);
    expect(undone.body.kit.company_brief).toMatchObject({ summary: "My careful notes", edited: true });
  });
});
