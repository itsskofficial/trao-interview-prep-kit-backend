import { describe, expect, it } from "vitest";
import { processDigest } from "../src/retrieval/excerpt";

const terms = { strong: ["take-home", "technical interview", "recruiter call", "offer"], weak: ["interview", "stage", "recruiter"] };
const filler = (n: number, label: string) => Array.from({ length: n }, (_, i) => `${label} paragraph ${i} about our philosophy and values and how we think.`);

describe("processDigest", () => {
  it("returns a short page whole", () => {
    expect(processDigest("Short page.\nInterview on Monday.", terms, 500)).toBe("Short page.\nInterview on Monday.");
  });

  it("keeps the lines about the process from anywhere in a long page, in page order", () => {
    const stages = ["1. A recruiter call.", "2. A take-home exercise.", "3. A technical interview.", "4. An offer within a week."];
    const text = [...filler(40, "Intro"), stages[0], ...filler(40, "Middle"), stages[1], stages[2], ...filler(40, "More"), stages[3], ...filler(40, "Outro")].join("\n");

    expect(processDigest(text, terms, 600)).toBe(stages.join("\n"));
  });

  it("drops the lines that say least first when even the relevant ones do not fit", () => {
    const logistics = Array.from({ length: 30 }, (_, i) => `Book interview slot ${i} in the applicant tracking system before the stage review.`);
    const stages = ["Stage one is a recruiter call.", "Stage two is a take-home exercise.", "Stage three is a technical interview."];
    const digest = processDigest([...logistics, ...stages].join("\n"), terms, 400);

    expect(digest.length).toBeLessThanOrEqual(400);
    for (const stage of stages) expect(digest).toContain(stage);
  });

  it("falls back to the top of a page that never mentions the terms", () => {
    const text = filler(50, "Plain").join("\n");
    expect(processDigest(text, terms, 300)).toBe(text.split("\n").slice(0, 4).join("\n"));
  });

  it("does not let one enormous paragraph crowd out everything else", () => {
    const text = [`An interview ${"x".repeat(5_000)}`, "Then a take-home exercise.", ...filler(40, "End")].join("\n");
    const digest = processDigest(text, terms, 1_000);
    expect(digest).toContain("Then a take-home exercise.");
    expect(digest.length).toBeLessThanOrEqual(1_000);
  });
});
