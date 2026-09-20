import { describe, expect, it } from "vitest";
import { SYSTEM as BRIEF_SYSTEM } from "../src/generation/brief";
import { offlineProvider } from "../src/llm/providers/offline";
import { wrapUntrusted } from "../src/llm/untrusted";

const ask = async (hiringPage: string) => {
  const prompt = `Company: Acme\n\n${wrapUntrusted("company_page", "Acme\nAcme makes anvils.")}\n\n${wrapUntrusted("hiring_page", hiringPage)}`;
  const answer = await offlineProvider().complete({ system: BRIEF_SYSTEM, prompt, jsonSchema: {}, maxOutputTokens: 1_000 }, AbortSignal.timeout(1_000));
  return JSON.parse(answer.text) as { hiring_stages: Array<{ stage: string; evidence: string }> };
};

describe("offline provider", () => {
  it("names a numbered stage by its words, not by its number", async () => {
    const { hiring_stages: stages } = await ask("How we hire\n1. Recruiter screen (30 minutes)\n2) Take-home exercise. Four hours at most.\n- Final interview with the hiring manager");
    expect(stages.map((stage) => stage.stage)).toEqual(["Recruiter screen", "Take-home exercise", "Final interview with the hiring manager"]);
    // Evidence stays the whole line as it stands on the page, so it can be found there verbatim.
    expect(stages[0]!.evidence).toBe("1. Recruiter screen (30 minutes)");
  });
});
