import type { Kit, Question, Requirement, ScheduleDay } from "../kit/schema";

/** Study time per question by difficulty 1, 2, 3. Integers, so every day's total is an integer. */
const MINUTES_BY_DIFFICULTY: Record<number, number> = { 1: 10, 2: 15, 3: 20 };
const MIN_MINUTES_PER_DAY = 30;
const MAX_REVISION_QUESTIONS_PER_DAY = 6;

const CATEGORY_LABEL: Record<Question["category"], string> = {
  technical: "Technical",
  behavioural: "Behavioural",
  "system-design": "System design",
  "company-fit": "Company fit",
};

export interface ScheduleInput {
  days: number;
  questions: Question[];
  requirements: Requirement[];
}

/**
 * Pure allocation, no model involved. Questions are ranked must-have first and
 * hardest first, then dealt out in that order across exactly `days` days, so
 * the most important material lands earliest. Every question is scheduled.
 * When there are more days than questions, the remaining days revisit the
 * material in the same priority order instead of sitting empty.
 */
export function allocateSchedule({ days, questions, requirements }: ScheduleInput): Kit["schedule"] {
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`days must be a positive integer, got ${days}`);

  const ranked = rankQuestions(questions, requirements);
  const learningDays = Math.min(days, ranked.length);
  const schedule: ScheduleDay[] = [];

  // Learning days: contiguous slices of the ranking, with any remainder going to the earliest days.
  const base = learningDays === 0 ? 0 : Math.floor(ranked.length / learningDays);
  const extra = learningDays === 0 ? 0 : ranked.length % learningDays;
  let cursor = 0;
  for (let index = 0; index < learningDays; index++) {
    const size = base + (index < extra ? 1 : 0);
    const slice = ranked.slice(cursor, cursor + size);
    cursor += size;
    schedule.push(buildDay(index + 1, slice, requirements, "learn"));
  }

  // Revision days: cycle through the ranking again, weakest-link-first order preserved.
  const revisionDays = days - learningDays;
  const perRevisionDay = Math.min(
    MAX_REVISION_QUESTIONS_PER_DAY,
    Math.max(2, Math.ceil(ranked.length / Math.max(revisionDays, 1))),
  );
  let revisionCursor = 0;
  for (let index = 0; index < revisionDays; index++) {
    const slice: Question[] = [];
    for (let taken = 0; taken < Math.min(perRevisionDay, ranked.length); taken++) {
      slice.push(ranked[revisionCursor % ranked.length]!);
      revisionCursor++;
    }
    schedule.push(buildDay(learningDays + index + 1, slice, requirements, "revise"));
  }

  return { days_available: days, days: schedule };
}

export function rankQuestions(questions: Question[], requirements: Requirement[]): Question[] {
  const mustIds = new Set(requirements.filter((r) => r.priority === "must").map((r) => r.id));
  const coversMust = (question: Question) => question.requirement_ids.some((id) => mustIds.has(id));

  return questions
    .map((question, index) => ({ question, index }))
    .sort(
      (a, b) =>
        Number(coversMust(b.question)) - Number(coversMust(a.question)) ||
        b.question.difficulty - a.question.difficulty ||
        a.index - b.index,
    )
    .map(({ question }) => question);
}

function buildDay(day: number, questions: Question[], requirements: Requirement[], mode: "learn" | "revise"): ScheduleDay {
  const studyMinutes = questions.reduce((sum, q) => sum + (MINUTES_BY_DIFFICULTY[q.difficulty] ?? 15), 0);
  // Revisiting takes about half as long as first contact.
  const minutes = mode === "learn" ? studyMinutes : Math.ceil(studyMinutes / 2);

  return {
    day,
    focus: describeFocus(questions, requirements, mode),
    question_ids: questions.map((q) => q.id),
    minutes: Math.max(MIN_MINUTES_PER_DAY, minutes),
  };
}

function describeFocus(questions: Question[], requirements: Requirement[], mode: "learn" | "revise"): string {
  if (questions.length === 0) return "No questions yet: re-read the job description and the company brief";

  const categories = [...new Set(questions.map((q) => CATEGORY_LABEL[q.category]))].join(" and ");
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const topics = [...new Set(questions.flatMap((q) => q.requirement_ids))]
    .map((id) => byId.get(id)?.text)
    .filter((text): text is string => Boolean(text))
    .slice(0, 2)
    .map((text) => (text.length > 48 ? `${text.slice(0, 45).trimEnd()}...` : text));

  const subject = topics.length > 0 ? `${categories}: ${topics.join("; ")}` : categories;
  return mode === "learn" ? subject : `Revision - ${subject}`;
}
