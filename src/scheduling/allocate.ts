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

export type Replan = NonNullable<Kit["schedule"]["replan"]>;

export interface ScheduleInput {
  days: number;
  questions: Question[];
  requirements: Requirement[];
  /** Re-plan the days from `from_day` on, putting the focus questions first. Earlier days are kept as they were. */
  replan?: Replan;
  /** The schedule being replaced; needed to keep the days before `from_day`. */
  previousDays?: ScheduleDay[];
}

/**
 * Pure allocation, no model involved. Questions are ranked must-have first and
 * hardest first, then dealt out in that order across exactly `days` days, so
 * the most important material lands earliest. Every question is scheduled.
 * When there are more days than questions, the remaining days revisit the
 * material in the same priority order instead of sitting empty.
 */
export function allocateSchedule(input: ScheduleInput): Kit["schedule"] {
  const { days, questions, requirements, replan, previousDays = [] } = input;
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`days must be a positive integer, got ${days}`);
  if (!replan) return { days_available: days, days: deal(rankQuestions(questions, requirements), days, requirements) };

  // A re-plan keeps the days already behind the user and deals everything out again over the days that are left,
  // weak spots first. Every question is still scheduled, so the schedule's guarantees hold.
  const keep = Math.max(0, Math.min(replan.from_day - 1, days - 1, previousDays.length));
  const existing = new Set(questions.map((question) => question.id));
  const kept = previousDays.slice(0, keep).map((day, index) => ({ ...day, day: index + 1, question_ids: day.question_ids.filter((id) => existing.has(id)) }));
  const rest = deal(focusFirst(questions, requirements, replan.focus_question_ids), days - keep, requirements);
  return {
    days_available: days,
    days: [...kept, ...rest.map((day) => ({ ...day, day: day.day + keep }))],
    replan: { from_day: keep + 1, focus_question_ids: replan.focus_question_ids.filter((id) => existing.has(id)) },
  };
}

/** Deals an already ranked list of questions across exactly `days` days. */
function deal(ranked: Question[], days: number, requirements: Requirement[]): ScheduleDay[] {
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

  return schedule;
}

/** The usual ranking, with the focus questions moved to the front in their ranked order. */
function focusFirst(questions: Question[], requirements: Requirement[], focusIds: string[]): Question[] {
  const focus = new Set(focusIds);
  const ranked = rankQuestions(questions, requirements);
  return [...ranked.filter((question) => focus.has(question.id)), ...ranked.filter((question) => !focus.has(question.id))];
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
