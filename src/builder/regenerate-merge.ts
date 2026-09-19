import { fallbackQuestion, findUncovered } from "../coverage/coverage";
import { normalise } from "../extraction/evidence";
import type { DraftQuestion } from "../generation/questions";
import type { Kit, Question, QuestionCategory } from "../kit/schema";
import { isProtected, reconcile, type BuilderState } from "./operations";

export interface MergeResult {
  state: BuilderState;
  /** What the regeneration took out, kept so it can be put back. */
  removed: Question[];
  /** What it put in. */
  addedIds: string[];
}

/**
 * Applies a freshly generated set of questions for one category to the kit as
 * it is NOW, not as it was when generation started. That distinction is the
 * whole point: generation takes seconds, the user keeps working, and whatever
 * they touched in the meantime is protected by the time this runs.
 *
 * - Questions in other categories are not read, moved or rewritten.
 * - In this category, protected questions (user-written, edited or pinned) stay, in their slots.
 * - Every other question in this category is replaced. New questions fill the freed slots in
 *   order; any left over go after the category's last question.
 * - A draft that repeats a surviving question is dropped.
 * - New ids come from the counters, so nothing removed ever has its id reused.
 * - If the swap left a must-have requirement uncovered, code writes a fallback question for it.
 * - Coverage and schedule are then recomputed.
 */
export function mergeRegeneratedQuestions(state: BuilderState, category: QuestionCategory, drafts: DraftQuestion[]): MergeResult {
  const { kit } = state;
  let q = state.counters.q;
  const nextQuestion = (draft: DraftQuestion): Question => ({ id: `q${++q}`, ...draft, category });

  const survivors = kit.questions.filter((question) => question.category === category && isProtected(question));
  const taken = new Set(survivors.map((question) => normalise(question.prompt)));
  const fresh = drafts.filter((draft) => {
    const key = normalise(draft.prompt);
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });

  const removed: Question[] = [];
  const added: Question[] = [];
  const merged: Question[] = [];
  let lastSlot = -1;
  for (const question of kit.questions) {
    if (question.category !== category) {
      merged.push(question);
    } else if (isProtected(question)) {
      merged.push(question);
      lastSlot = merged.length - 1;
    } else {
      removed.push(question);
      const draft = fresh.shift();
      if (draft) {
        added.push(nextQuestion(draft));
        merged.push(added.at(-1)!);
        lastSlot = merged.length - 1;
      }
    }
  }
  const extras = fresh.map(nextQuestion);
  added.push(...extras);
  merged.splice(lastSlot === -1 ? merged.length : lastSlot + 1, 0, ...extras);

  // The guarantee from the first generation still holds after a regeneration.
  const uncoveredMust = findUncovered(kit.role.requirements, merged).filter((requirement) => requirement.priority === "must");
  const fallbacks = uncoveredMust.map((requirement) => ({ id: `q${++q}`, ...fallbackQuestion(requirement) }));
  added.push(...fallbacks);

  return {
    removed,
    addedIds: added.map((question) => question.id),
    state: { counters: { ...state.counters, q }, kit: reconcile({ ...kit, questions: [...merged, ...fallbacks] }) },
  };
}

/** Puts back what a regeneration removed and takes out what it added, unless the user has since made an added question their own. */
export function undoRegeneratedQuestions(state: BuilderState, category: QuestionCategory, removed: Question[], addedIds: string[]): BuilderState {
  const { kit } = state;
  const drop = new Set(kit.questions.filter((question) => addedIds.includes(question.id) && !isProtected(question)).map((question) => question.id));
  const present = new Set(kit.questions.map((question) => question.id));
  const restore = removed.filter((question) => !present.has(question.id));

  const kept = kit.questions.filter((question) => !drop.has(question.id));
  const lastInCategory = kept.reduce((last, question, index) => (question.category === category ? index : last), -1);
  const at = lastInCategory === -1 ? kept.length : lastInCategory + 1;
  const questions = [...kept.slice(0, at), ...restore, ...kept.slice(at)];
  return { ...state, kit: reconcile({ ...kit, questions }) };
}

/** A brief the user has edited or pinned is only replaced when they explicitly say so. */
export function mergeRegeneratedBrief(kit: Kit, brief: Kit["company_brief"], extras: Pick<Kit, "hiring_stages" | "interview_insights">): Kit {
  return { ...kit, company_brief: { ...brief, origin: "generated" }, ...extras };
}
