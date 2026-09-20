import type { Question } from "../kit/schema";
import { groupDuplicates } from "./duplicates";
import type { Embedder } from "./embedder";

export interface MergeResult<Q> {
  questions: Q[];
  removed: Array<{ id: string; into: string }>;
  comparedWith: string;
}

type Mergeable = Pick<Question, "id" | "prompt" | "requirement_ids" | "category">;

/**
 * Keeps the first of each group of questions that ask the same thing, and gives it the requirements
 * the others covered, so removing a duplicate can never uncover a requirement. Questions in different
 * categories are never merged: a technical and a behavioural question about the same subject are
 * different interviews.
 */
export async function mergeDuplicateQuestions<Q extends Mergeable>(questions: Q[], embedder: Embedder, signal?: AbortSignal): Promise<MergeResult<Q>> {
  const kept: Q[] = [];
  const removed: MergeResult<Q>["removed"] = [];

  // One embedding call for the whole kit; the category rule is applied when pairs are compared.
  const grouped = await groupDuplicates(questions, (question) => question.prompt, embedder, { signal, comparable: (a, b) => a.category === b.category });
  for (const group of grouped.groups) {
    const requirementIds = [...new Set([group.kept, ...group.duplicates].flatMap((question) => question.requirement_ids))];
    kept.push(group.duplicates.length > 0 ? { ...group.kept, requirement_ids: requirementIds } : group.kept);
    for (const duplicate of group.duplicates) removed.push({ id: duplicate.id, into: group.kept.id });
  }

  // Back in the order they came in.
  const position = new Map(questions.map((question, index) => [question.id, index]));
  kept.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  return { questions: kept, removed, comparedWith: grouped.comparedWith };
}

/**
 * The drafts that ask something new: not what an existing question already asks, and not what an
 * earlier draft asks. Used when regenerating, where the model has been told which questions the
 * user is keeping and sometimes writes them again anyway.
 */
export async function withoutDuplicates<D extends { prompt: string }>(existing: string[], drafts: D[], embedder: Embedder, signal?: AbortSignal): Promise<{ fresh: D[]; dropped: number }> {
  type Entry = { prompt: string; draft?: D };
  const entries: Entry[] = [...existing.map((prompt) => ({ prompt })), ...drafts.map((draft) => ({ prompt: draft.prompt, draft }))];
  const grouped = await groupDuplicates(entries, (entry) => entry.prompt, embedder, { signal });
  const fresh = grouped.groups.flatMap((group) => (group.kept.draft ? [group.kept.draft] : []));
  return { fresh, dropped: drafts.length - fresh.length };
}
