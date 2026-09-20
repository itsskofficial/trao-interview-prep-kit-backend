import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { CANARY_CEILING, judgeConfigFor, judgeKit, summarise, type KitJudgement } from "../src/evals/judge";
import { fakeLlmClient } from "../src/llm/fake";
import type { LlmProvider, ProviderRequest } from "../src/llm/types";
import { appendixAKit } from "./support/kits";

/** A judge that scores whatever a test tells it to, by reading the items out of the prompt the way a model would. */
function scriptedJudge(scoreFor: (block: string) => number, options: { skip?: (label: string) => boolean } = {}): LlmProvider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    name: "scripted-judge",
    requests,
    async complete(request) {
      requests.push(request);
      const blocks = [...request.prompt.matchAll(/\[([QF]\d+)\]\n([\s\S]*?)(?=\n\n\[[QF]\d+\]|\n<\/untrusted_items>)/g)];
      const flashcards = request.system.includes("flashcards");
      const items = blocks
        .filter(([, label]) => !options.skip?.(label!))
        .map(([, label, block]) => {
          const value = scoreFor(block!);
          return flashcards ? { id: label, reason: "scripted", correctness: value, clarity: value } : { id: label, reason: "scripted", relevance: value, specificity: value, difficulty_fit: value, outline: value };
        });
      return { text: JSON.stringify({ items }) };
    },
  };
}

const planted = (block: string) => /favourite colour|Talk about it|server is overloaded/.test(block);
const kit = appendixAKit();

describe("judging a kit", () => {
  it("scores every question and flashcard, in batches, under labels that do not give planted items away", async () => {
    const judge = scriptedJudge((block) => (planted(block) ? 1 : 4));
    const result = await judgeKit("case-1", kit, fakeLlmClient([judge]));

    const real = result.items.filter((item) => !item.canary);
    expect(real.filter((item) => item.kind === "question").map((item) => item.ref).sort()).toEqual(kit.questions.map((q) => q.id).sort());
    expect(real.filter((item) => item.kind === "flashcard").map((item) => item.ref).sort()).toEqual(kit.flashcards.map((f) => f.id).sort());
    expect(result.items.filter((item) => item.canary).map((item) => item.ref).sort()).toEqual(["canary-generic", "canary-irrelevant", "canary-wrong"]);
    expect(result.unscored).toBe(0);

    const prompts = judge.requests.map((request) => request.prompt).join("\n");
    expect(prompts).not.toMatch(/canary/i);
    expect(prompts).toContain("<untrusted_items>");
  });

  it("gives questions and flashcards their own rubric and their own calls", async () => {
    const judge = scriptedJudge(() => 3);
    await judgeKit("case-1", kit, fakeLlmClient([judge]));
    expect(judge.requests.some((request) => request.system.includes("relevance:") && !request.system.includes("correctness:"))).toBe(true);
    expect(judge.requests.some((request) => request.system.includes("correctness:") && !request.system.includes("relevance:"))).toBe(true);
  });

  it("shows the judge what each question is linked to, since relevance cannot be judged without it", async () => {
    const judge = scriptedJudge(() => 3);
    await judgeKit("case-1", kit, fakeLlmClient([judge]));
    const requirement = kit.role.requirements.find((r) => r.id === kit.questions[0]!.requirement_ids[0])!;
    expect(judge.requests.map((request) => request.prompt).join("\n")).toContain(`Linked requirement(s): ${requirement.text}`);
  });

  it("counts an item the judge skipped instead of inventing a score for it", async () => {
    const judge = scriptedJudge(() => 3, { skip: (label) => label === "Q1" });
    const result = await judgeKit("case-1", kit, fakeLlmClient([judge]));
    expect(result.unscored).toBe(1);
  });

  it("is reproducible: the same kit is presented in the same order", async () => {
    const first = scriptedJudge(() => 3);
    const second = scriptedJudge(() => 3);
    await judgeKit("case-1", kit, fakeLlmClient([first]));
    await judgeKit("case-1", kit, fakeLlmClient([second]));
    expect(first.requests.map((r) => r.prompt)).toEqual(second.requests.map((r) => r.prompt));
  });
});

describe("the report", () => {
  const judged = async (scoreFor: (block: string) => number): Promise<KitJudgement[]> => [await judgeKit("case-1", kit, fakeLlmClient([scriptedJudge(scoreFor)]))];

  it("believes a judge that scored the planted items low and the real ones clearly higher", async () => {
    const report = summarise(await judged((block) => (planted(block) ? 1 : 4)), "scripted-judge");
    expect(report.judgeCheck).toMatchObject({ reliable: true, canaryMean: 1, realMean: 4 });
    expect(report.overall).toMatchObject({ mean: 4, questionMean: 4, flashcardMean: 4, unscored: 0 });
    expect(report.overall.byDimension).toMatchObject({ relevance: 4, correctness: 4 });
    expect(report.kits[0]).toMatchObject({ id: "case-1", questions: kit.questions.length, flashcards: kit.flashcards.length });
  });

  it("does not believe a judge that liked everything", async () => {
    const report = summarise(await judged(() => 5), "scripted-judge");
    expect(report.judgeCheck.reliable).toBe(false);
    expect(report.judgeCheck.verdict).toContain("Do not rely");
  });

  it("does not believe a judge that let even one planted item through", async () => {
    const report = summarise(await judged((block) => (/Talk about it/.test(block) ? 4 : planted(block) ? 1 : 5)), "scripted-judge");
    expect(report.judgeCheck.canaries.some((canary) => canary.score > CANARY_CEILING)).toBe(true);
    expect(report.judgeCheck.reliable).toBe(false);
  });

  it("does not believe a judge that scored everything low, planted or not", async () => {
    expect(summarise(await judged(() => 2), "scripted-judge").judgeCheck.reliable).toBe(false);
  });

  it("checks each planted item only on what it was built to fail: a wrong flashcard is still a clear one", async () => {
    const judge: LlmProvider = {
      name: "fair-judge",
      async complete(request) {
        const labels = [...request.prompt.matchAll(/\[([QF]\d+)\]\n([\s\S]*?)(?=\n\n\[[QF]\d+\]|\n<\/untrusted_items>)/g)];
        const flashcards = request.system.includes("flashcards");
        return {
          text: JSON.stringify({
            items: labels.map(([, id, block]) =>
              flashcards
                ? { id, reason: "r", correctness: /server is overloaded/.test(block!) ? 1 : 5, clarity: 5 }
                : { id, reason: "r", relevance: /favourite colour/.test(block!) ? 1 : 4, specificity: /Talk about it/.test(block!) ? 1 : 4, difficulty_fit: 4, outline: 4 },
            ),
          }),
        };
      },
    };
    const report = summarise([await judgeKit("case-1", kit, fakeLlmClient([judge]))], "fair-judge");
    expect(report.judgeCheck.canaries.find((canary) => canary.ref === "canary-wrong")).toMatchObject({ dimension: "correctness", score: 1 });
    expect(report.judgeCheck.reliable).toBe(true);
  });

  it("keeps planted items out of the means and out of the weakest list", async () => {
    const report = summarise(await judged((block) => (planted(block) ? 1 : /Front:/.test(block) ? 5 : 3)), "scripted-judge");
    expect(report.overall).toMatchObject({ questionMean: 3, flashcardMean: 5 });
    expect(report.weakest.every((item) => !item.ref.startsWith("canary"))).toBe(true);
    expect(report.weakest[0]!.mean).toBe(3);
  });

  it("says so when there was nothing planted to check the judge with", () => {
    const report = summarise([{ id: "x", items: [{ kind: "question", ref: "q1", canary: false, text: "t", reason: "r", scores: { relevance: 4 }, mean: 4 }], unscored: 0 }], "j");
    expect(report.judgeCheck).toMatchObject({ reliable: false, verdict: expect.stringContaining("not checked") });
  });
});

describe("choosing the judge", () => {
  const config = (env: Record<string, string>) => loadConfig({ JWT_SECRET: "x".repeat(40), ...env });

  it("uses the other provider when there is a key for it, so a model does not mark its own work", () => {
    const chosen = judgeConfigFor(config({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" }), ["gemini:gemini-3.5-flash-lite"]);
    expect(chosen.config.LLM_PROVIDER).toBe("groq");
    expect(chosen.note).toContain("judging with groq");
  });

  it("goes the other way too", () => {
    expect(judgeConfigFor(config({ LLM_PROVIDER: "groq", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" }), ["groq:openai/gpt-oss-120b"]).config.LLM_PROVIDER).toBe("gemini");
  });

  it("falls back to the same provider when it is the only one with a key, and says the scores will be lenient", () => {
    const chosen = judgeConfigFor(config({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g" }), ["gemini:gemini-3.5-flash-lite"]);
    expect(chosen.config.LLM_PROVIDER).toBe("gemini");
    expect(chosen.note).toContain("lenient");
  });

  it("uses the configured provider for kits that do not say what made them", () => {
    expect(judgeConfigFor(config({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" }), []).config.LLM_PROVIDER).toBe("gemini");
  });
});
