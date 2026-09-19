import { describe, expect, it } from "vitest";
import { validateKit } from "../src/kit/validate";
import type { Kit } from "../src/kit/schema";
import { appendixAKit } from "./support/kits";

function issuesFor(mutate: (kit: Kit) => void): string[] {
  const kit = appendixAKit();
  mutate(kit);
  const result = validateKit(kit);
  return result.ok ? [] : result.issues;
}

describe("validateKit", () => {
  it("accepts a kit that uses only the Appendix A fields", () => {
    expect(validateKit(appendixAKit())).toMatchObject({ ok: true });
  });

  it("accepts the additive extensions", () => {
    const kit = appendixAKit();
    kit.questions[0]!.origin = "generated";
    kit.questions[0]!.pinned = true;
    kit.notes = ["The job description was thin."];
    kit.hiring_stages = ["Take-home", "System design"];
    kit.research_log = [{ source: "company-site", url: "http://localhost:8099/acme/", outcome: "used" }];
    expect(validateKit(kit)).toMatchObject({ ok: true });
  });

  it("rejects a missing required field and names it", () => {
    const kit = appendixAKit() as Partial<Kit>;
    delete kit.coverage;
    const result = validateKit(kit);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join("\n")).toContain("coverage");
  });

  it.each([
    ["a float", 60.5],
    ["a string", "about an hour"],
  ])("rejects minutes given as %s", (_label, minutes) => {
    const kit = appendixAKit() as unknown as { schedule: { days: Array<{ minutes: unknown }> } };
    kit.schedule.days[0]!.minutes = minutes;
    expect(validateKit(kit).ok).toBe(false);
  });

  it.each([0, 4, 2.5])("rejects difficulty %s", (difficulty) => {
    expect(issuesFor((kit) => (kit.questions[0]!.difficulty = difficulty))).not.toEqual([]);
  });

  it("rejects an unknown priority, kind or category", () => {
    const kit = appendixAKit() as unknown as {
      role: { requirements: Array<{ priority: string }> };
    };
    kit.role.requirements[0]!.priority = "required";
    expect(validateKit(kit).ok).toBe(false);
  });

  it("rejects duplicate ids", () => {
    expect(issuesFor((kit) => (kit.questions[1]!.id = "q1"))).toContain('questions: duplicate id "q1"');
  });

  it("rejects a question that references a requirement that does not exist", () => {
    const issues = issuesFor((kit) => kit.questions[0]!.requirement_ids.push("r99"));
    expect(issues).toEqual(['questions[q1].requirement_ids: unknown requirement id "r99"']);
  });

  it("rejects a flashcard that references a requirement that does not exist", () => {
    const issues = issuesFor((kit) => (kit.flashcards[0]!.requirement_ids = ["r99"]));
    expect(issues).toEqual(['flashcards[f1].requirement_ids: unknown requirement id "r99"']);
  });

  it("rejects an uncovered requirement id that does not exist", () => {
    const issues = issuesFor((kit) => (kit.coverage.uncovered_requirement_ids = ["r99"]));
    expect(issues).toEqual(['coverage.uncovered_requirement_ids: unknown requirement id "r99"']);
  });

  it("rejects a schedule that references a question that does not exist", () => {
    const issues = issuesFor((kit) => kit.schedule.days[0]!.question_ids.push("q99"));
    expect(issues).toEqual(['schedule.days[day 1].question_ids: unknown question id "q99"']);
  });

  it("rejects a schedule whose length differs from days_available", () => {
    const issues = issuesFor((kit) => (kit.schedule.days_available = 5));
    expect(issues).toEqual(["schedule.days: expected 5 days, found 2"]);
  });

  it("rejects days that are not numbered 1..n in order", () => {
    const issues = issuesFor((kit) => (kit.schedule.days[1]!.day = 3));
    expect(issues).toEqual(["schedule.days[1].day: expected 2, found 3"]);
  });

  it("reports every problem at once", () => {
    const issues = issuesFor((kit) => {
      kit.questions[0]!.requirement_ids = ["r99"];
      kit.schedule.days[0]!.question_ids = ["q99"];
    });
    expect(issues).toHaveLength(2);
  });
});
