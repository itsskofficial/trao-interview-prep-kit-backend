import { KitSchema, type Kit } from "./schema";

export type KitValidation = { ok: true; kit: Kit } | { ok: false; issues: string[] };

/**
 * Validates a kit's shape and its internal references. Returns every problem
 * found rather than the first, so a rejected model response can be repaired in one go.
 */
export function validateKit(input: unknown): KitValidation {
  const parsed = KitSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }

  const kit = parsed.data;
  const issues = [...duplicateIdIssues(kit), ...referenceIssues(kit), ...scheduleIssues(kit)];
  return issues.length === 0 ? { ok: true, kit } : { ok: false, issues };
}

function duplicateIdIssues(kit: Kit): string[] {
  const groups: Array<[string, Array<{ id: string }>]> = [
    ["role.requirements", kit.role.requirements],
    ["questions", kit.questions],
    ["flashcards", kit.flashcards],
  ];
  return groups.flatMap(([path, items]) => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const { id } of items) (seen.has(id) ? duplicates : seen).add(id);
    return [...duplicates].map((id) => `${path}: duplicate id "${id}"`);
  });
}

function referenceIssues(kit: Kit): string[] {
  const requirementIds = new Set(kit.role.requirements.map((r) => r.id));
  const unknownRequirement = (path: string, ids: string[]) =>
    ids.filter((id) => !requirementIds.has(id)).map((id) => `${path}: unknown requirement id "${id}"`);

  return [
    ...kit.questions.flatMap((q) => unknownRequirement(`questions[${q.id}].requirement_ids`, q.requirement_ids)),
    ...kit.flashcards.flatMap((f) => unknownRequirement(`flashcards[${f.id}].requirement_ids`, f.requirement_ids)),
    ...unknownRequirement("coverage.uncovered_requirement_ids", kit.coverage.uncovered_requirement_ids),
  ];
}

function scheduleIssues(kit: Kit): string[] {
  const { days_available, days } = kit.schedule;
  const issues: string[] = [];

  if (days.length !== days_available) {
    issues.push(`schedule.days: expected ${days_available} days, found ${days.length}`);
  }
  days.forEach((entry, index) => {
    if (entry.day !== index + 1) {
      issues.push(`schedule.days[${index}].day: expected ${index + 1}, found ${entry.day}`);
    }
  });

  const questionIds = new Set(kit.questions.map((q) => q.id));
  for (const entry of days) {
    for (const questionId of entry.question_ids) {
      if (!questionIds.has(questionId)) {
        issues.push(`schedule.days[day ${entry.day}].question_ids: unknown question id "${questionId}"`);
      }
    }
  }
  return issues;
}
