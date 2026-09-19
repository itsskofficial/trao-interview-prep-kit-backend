import { findUncovered } from "../coverage/coverage";
import type { Flashcard, Kit, Question, QuestionCategory } from "../kit/schema";
import { allocateSchedule } from "../scheduling/allocate";

/**
 * Every change a user can make to a kit, as a pure function from a kit to a
 * new kit. Nothing here talks to a database or a model, which is what makes
 * the rules below testable:
 *
 * - `origin` says where an item came from: "generated", "user", or "fallback" (written by code).
 * - `edited` is set the moment a user changes an item's content. It is never cleared.
 * - `pinned` is the user saying "keep this one". Moving a question to another category pins it.
 * - An item is PROTECTED if it is user-written, edited or pinned. Regeneration never touches a protected item.
 * - Ids are handed out from counters that only go up, so an id is never reused, even after a delete.
 * - After any change to the questions, coverage and the schedule are recomputed by code, so the
 *   kit can never reference a question that no longer exists.
 */

export interface Counters {
  q: number;
  f: number;
}

export interface BuilderState {
  kit: Kit;
  counters: Counters;
}

export class BuilderError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_OPERATION",
    message: string,
  ) {
    super(message);
    this.name = "BuilderError";
  }
}

export const isProtected = (item: { origin?: string; edited?: boolean; pinned?: boolean }): boolean =>
  item.origin === "user" || item.edited === true || item.pinned === true;

/** Coverage and schedule always follow from the questions. Days requested never change. */
export function reconcile(kit: Kit): Kit {
  return {
    ...kit,
    coverage: { ...kit.coverage, uncovered_requirement_ids: findUncovered(kit.role.requirements, kit.questions).map((r) => r.id) },
    schedule: allocateSchedule({ days: kit.schedule.days_available, questions: kit.questions, requirements: kit.role.requirements }),
  };
}

// ---------- questions ----------

export type QuestionPatch = Partial<Pick<Question, "prompt" | "answer_outline" | "difficulty" | "requirement_ids">>;

export function patchQuestion(state: BuilderState, id: string, patch: QuestionPatch): BuilderState {
  const current = find(state.kit.questions, id, "Question");
  assertKnownRequirements(state.kit, patch.requirement_ids);
  const next = { ...current, ...definedOnly(patch) };
  const changed = (Object.keys(patch) as Array<keyof QuestionPatch>).some((key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]));
  if (!changed) return state;

  const questions = state.kit.questions.map((q) => (q.id === id ? { ...next, edited: true } : q));
  return { ...state, kit: reconcile({ ...state.kit, questions }) };
}

export interface NewQuestion extends Pick<Question, "category" | "prompt"> {
  answer_outline?: string;
  difficulty?: number;
  requirement_ids?: string[];
}

export function addQuestion(state: BuilderState, input: NewQuestion): { state: BuilderState; id: string } {
  assertKnownRequirements(state.kit, input.requirement_ids);
  const q = state.counters.q + 1;
  const question: Question = {
    id: `q${q}`,
    category: input.category,
    prompt: input.prompt,
    answer_outline: input.answer_outline ?? "",
    difficulty: input.difficulty ?? 2,
    requirement_ids: input.requirement_ids ?? [],
    origin: "user",
  };
  // A new question goes to the end of its category, which is where the user is looking when they add it.
  const questions = insertIntoCategory(state.kit.questions, question, Number.POSITIVE_INFINITY);
  return { id: question.id, state: { counters: { ...state.counters, q }, kit: reconcile({ ...state.kit, questions }) } };
}

export function deleteQuestion(state: BuilderState, id: string): BuilderState {
  find(state.kit.questions, id, "Question");
  return { ...state, kit: reconcile({ ...state.kit, questions: state.kit.questions.filter((q) => q.id !== id) }) };
}

/** `ids` is the complete new order of one category. Other categories keep their places in the list. */
export function reorderQuestions(state: BuilderState, category: QuestionCategory, ids: string[]): BuilderState {
  const inCategory = state.kit.questions.filter((q) => q.category === category);
  assertSameMembers(inCategory.map((q) => q.id), ids, "questions in this category");

  const byId = new Map(inCategory.map((q) => [q.id, q]));
  const reordered = ids.map((id) => byId.get(id)!);
  let cursor = 0;
  const questions = state.kit.questions.map((q) => (q.category === category ? reordered[cursor++]! : q));
  return { ...state, kit: reconcile({ ...state.kit, questions }) };
}

/** Moving a question is a deliberate act, so it pins the question: regenerating its new category will not remove it. */
export function moveQuestion(state: BuilderState, id: string, category: QuestionCategory, index: number): BuilderState {
  const current = find(state.kit.questions, id, "Question");
  const moved: Question = current.category === category ? current : { ...current, category, pinned: true };
  const others = state.kit.questions.filter((q) => q.id !== id);
  return { ...state, kit: reconcile({ ...state.kit, questions: insertIntoCategory(others, moved, index) }) };
}

// ---------- flashcards ----------

export type FlashcardPatch = Partial<Pick<Flashcard, "front" | "back" | "requirement_ids">>;

export function patchFlashcard(state: BuilderState, id: string, patch: FlashcardPatch): BuilderState {
  const current = find(state.kit.flashcards, id, "Flashcard");
  assertKnownRequirements(state.kit, patch.requirement_ids);
  const next = { ...current, ...definedOnly(patch) };
  if (JSON.stringify(next) === JSON.stringify(current)) return state;
  return { ...state, kit: { ...state.kit, flashcards: state.kit.flashcards.map((f) => (f.id === id ? { ...next, edited: true } : f)) } };
}

export function addFlashcard(state: BuilderState, input: Pick<Flashcard, "front"> & Partial<Pick<Flashcard, "back" | "requirement_ids">>): { state: BuilderState; id: string } {
  assertKnownRequirements(state.kit, input.requirement_ids);
  const f = state.counters.f + 1;
  const card: Flashcard = { id: `f${f}`, front: input.front, back: input.back ?? "", requirement_ids: input.requirement_ids ?? [], origin: "user" };
  return { id: card.id, state: { counters: { ...state.counters, f }, kit: { ...state.kit, flashcards: [...state.kit.flashcards, card] } } };
}

export function deleteFlashcard(state: BuilderState, id: string): BuilderState {
  find(state.kit.flashcards, id, "Flashcard");
  return { ...state, kit: { ...state.kit, flashcards: state.kit.flashcards.filter((f) => f.id !== id) } };
}

export function reorderFlashcards(state: BuilderState, ids: string[]): BuilderState {
  assertSameMembers(state.kit.flashcards.map((f) => f.id), ids, "flashcards");
  const byId = new Map(state.kit.flashcards.map((f) => [f.id, f]));
  return { ...state, kit: { ...state.kit, flashcards: ids.map((id) => byId.get(id)!) } };
}

// ---------- brief and pins ----------

export type BriefPatch = Partial<Pick<Kit["company_brief"], "summary" | "what_they_do">>;

export function patchBrief(state: BuilderState, patch: BriefPatch): BuilderState {
  const next = { ...state.kit.company_brief, ...definedOnly(patch) };
  if (JSON.stringify(next) === JSON.stringify(state.kit.company_brief)) return state;
  return { ...state, kit: { ...state.kit, company_brief: { ...next, edited: true } } };
}

export type PinTarget = { kind: "question" | "flashcard"; id: string } | { kind: "brief" };

export function setPinned(state: BuilderState, target: PinTarget, pinned: boolean): BuilderState {
  const { kit } = state;
  if (target.kind === "brief") return { ...state, kit: { ...kit, company_brief: { ...kit.company_brief, pinned } } };
  if (target.kind === "question") {
    find(kit.questions, target.id, "Question");
    return { ...state, kit: { ...kit, questions: kit.questions.map((q) => (q.id === target.id ? { ...q, pinned } : q)) } };
  }
  find(kit.flashcards, target.id, "Flashcard");
  return { ...state, kit: { ...kit, flashcards: kit.flashcards.map((f) => (f.id === target.id ? { ...f, pinned } : f)) } };
}

// ---------- helpers ----------

function find<T extends { id: string }>(items: T[], id: string, what: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new BuilderError("NOT_FOUND", `${what} ${id} does not exist in this kit.`);
  return item;
}

function assertKnownRequirements(kit: Kit, ids: string[] | undefined): void {
  const known = new Set(kit.role.requirements.map((r) => r.id));
  const unknown = (ids ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) throw new BuilderError("INVALID_OPERATION", `Unknown requirement id(s): ${unknown.join(", ")}.`);
}

function assertSameMembers(current: string[], proposed: string[], what: string): void {
  const same = current.length === proposed.length && new Set(proposed).size === proposed.length && proposed.every((id) => current.includes(id));
  if (!same) throw new BuilderError("INVALID_OPERATION", `The new order must list exactly the ${what}, once each.`);
}

/** Places a question at `index` among the questions of its own category, leaving every other category where it is. */
function insertIntoCategory(questions: Question[], question: Question, index: number): Question[] {
  const positions = questions.flatMap((q, position) => (q.category === question.category ? [position] : []));
  const slot = Math.max(0, Math.min(Math.trunc(Number.isFinite(index) ? index : positions.length), positions.length));
  // Before the question currently at that slot, or straight after the category's last question.
  const at = slot < positions.length ? positions[slot]! : positions.length > 0 ? positions.at(-1)! + 1 : questions.length;
  return [...questions.slice(0, at), question, ...questions.slice(at)];
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}
