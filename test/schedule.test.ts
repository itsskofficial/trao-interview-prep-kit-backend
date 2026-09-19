import { describe, expect, it } from "vitest";
import type { Question, Requirement } from "../src/kit/schema";
import { allocateSchedule } from "../src/scheduling/allocate";

const requirements: Requirement[] = [
  { id: "r1", text: "5+ years with Node.js", kind: "technical", priority: "must" },
  { id: "r2", text: "PostgreSQL", kind: "technical", priority: "must" },
  { id: "r3", text: "Mentoring junior engineers", kind: "behavioural", priority: "must" },
  { id: "r4", text: "Kubernetes", kind: "technical", priority: "nice" },
];

function question(id: string, requirementId: string, difficulty: number, category: Question["category"] = "technical"): Question {
  return { id, requirement_ids: [requirementId], category, prompt: `Prompt ${id}`, answer_outline: "", difficulty };
}

/** 12 questions: three per requirement, difficulties 1-3, deliberately listed easiest and nice-to-have first. */
const questions: Question[] = ["r4", "r3", "r2", "r1"].flatMap((requirementId, group) =>
  [1, 2, 3].map((difficulty, i) => question(`q${group * 3 + i + 1}`, requirementId, difficulty)),
);

const mustIds = new Set(requirements.filter((r) => r.priority === "must").map((r) => r.id));
const byId = new Map(questions.map((q) => [q.id, q]));
const isMust = (id: string) => byId.get(id)!.requirement_ids.some((r) => mustIds.has(r));

describe("allocateSchedule", () => {
  it.each([1, 5, 12, 13, 60])("produces exactly %i days, numbered from 1", (days) => {
    const schedule = allocateSchedule({ days, questions, requirements });
    expect(schedule.days_available).toBe(days);
    expect(schedule.days.map((d) => d.day)).toEqual(Array.from({ length: days }, (_, i) => i + 1));
  });

  it.each([1, 5, 60])("gives every day a focus, integer minutes and only existing question ids (%i days)", (days) => {
    for (const day of allocateSchedule({ days, questions, requirements }).days) {
      expect(day.focus.length).toBeGreaterThan(0);
      expect(Number.isInteger(day.minutes)).toBe(true);
      expect(day.minutes).toBeGreaterThanOrEqual(30);
      expect(day.question_ids.every((id) => byId.has(id))).toBe(true);
    }
  });

  it.each([1, 5, 60])("schedules every question, so every must-have requirement appears (%i days)", (days) => {
    const scheduled = new Set(allocateSchedule({ days, questions, requirements }).days.flatMap((d) => d.question_ids));
    expect(scheduled.size).toBe(questions.length);
    const coveredRequirements = new Set([...scheduled].flatMap((id) => byId.get(id)!.requirement_ids));
    for (const id of mustIds) expect(coveredRequirements.has(id)).toBe(true);
  });

  it("puts everything into the single day when there is one day", () => {
    const [only] = allocateSchedule({ days: 1, questions, requirements }).days;
    expect(only!.question_ids).toHaveLength(12);
    expect(only!.minutes).toBe(4 * (10 + 15 + 20));
  });

  it("puts must-have material before nice-to-have material", () => {
    const order = allocateSchedule({ days: 4, questions, requirements }).days.flatMap((d) => d.question_ids);
    const firstNice = order.findIndex((id) => !isMust(id));
    expect(order.slice(firstNice).some(isMust)).toBe(false);
    expect(allocateSchedule({ days: 4, questions, requirements }).days.at(-1)!.question_ids.every((id) => !isMust(id))).toBe(true);
  });

  it("puts harder must-have questions before easier ones", () => {
    const order = allocateSchedule({ days: 4, questions, requirements }).days.flatMap((d) => d.question_ids);
    const mustDifficulties = order.filter(isMust).map((id) => byId.get(id)!.difficulty);
    expect(mustDifficulties).toEqual([...mustDifficulties].sort((a, b) => b - a));
  });

  it("gives leftover questions to the earliest days", () => {
    const sizes = allocateSchedule({ days: 5, questions, requirements }).days.map((d) => d.question_ids.length);
    expect(sizes).toEqual([3, 3, 2, 2, 2]);
  });

  it("turns days beyond the material into revision days that reuse existing questions, hardest must-haves first", () => {
    const schedule = allocateSchedule({ days: 60, questions, requirements });
    const revision = schedule.days.slice(12);
    expect(revision).toHaveLength(48);
    expect(revision.every((d) => d.focus.startsWith("Revision"))).toBe(true);
    expect(revision.every((d) => d.question_ids.length >= 2)).toBe(true);
    expect(isMust(revision[0]!.question_ids[0]!)).toBe(true);
    expect(byId.get(revision[0]!.question_ids[0]!)!.difficulty).toBe(3);
  });

  it("still returns the requested number of valid days when there are no questions", () => {
    const schedule = allocateSchedule({ days: 3, questions: [], requirements: [] });
    expect(schedule.days).toHaveLength(3);
    expect(schedule.days.every((d) => d.question_ids.length === 0 && d.minutes === 30 && d.focus.length > 0)).toBe(true);
  });

  it("handles fewer questions than days", () => {
    const schedule = allocateSchedule({ days: 5, questions: questions.slice(0, 2), requirements });
    expect(schedule.days).toHaveLength(5);
    expect(schedule.days.slice(0, 2).every((d) => d.question_ids.length === 1)).toBe(true);
  });

  it("is deterministic", () => {
    const input = { days: 7, questions, requirements };
    expect(allocateSchedule(input)).toEqual(allocateSchedule(input));
  });

  it.each([0, -1, 2.5])("rejects days = %s", (days) => {
    expect(() => allocateSchedule({ days, questions, requirements })).toThrow(RangeError);
  });
});
