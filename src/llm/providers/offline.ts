import type { LlmProvider, ProviderRequest } from "../types";

/**
 * A stand-in for a model that needs no key, no network and no quota. It exists
 * for end-to-end tests of the interface and for running the whole application
 * locally; it is never the default and is refused in production. Its answers
 * are mechanical on purpose: requirements are the posting's bullet lines,
 * questions are templated. Everything downstream (evidence checks, coverage,
 * scheduling, merging) is the real code.
 */
export function offlineProvider(): LlmProvider {
  return {
    name: "offline",
    async complete(request) {
      return { text: JSON.stringify(answer(request)) };
    },
  };
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;
const BEHAVIOURAL = /\b(mentor|communicat|collaborat|stakeholder|team|lead|explain|ownership|on-call)\w*/i;
const STAGE = /\b(interview|recruiter|screen|take-home|exercise|round|pair programming|on-site|onsite|offer)\b/i;

const block = (prompt: string, label: string) => new RegExp(`<untrusted_${label}>\\n([\\s\\S]*?)\\n</untrusted_${label}>`).exec(prompt)?.[1] ?? "";
const requirementLines = (prompt: string) => [...block(prompt, "requirements").matchAll(/^(r\d+) \[(must|nice)\] (.+)$/gm)].map(([, id, , text]) => ({ id: id!, text: text! }));

function answer({ system, prompt }: ProviderRequest): unknown {
  if (system.startsWith("You read one job description")) {
    const lines = block(prompt, "job_description").split(/\r?\n/);
    const bullets = lines.flatMap((line) => (BULLET.exec(line)?.[1] ? [BULLET.exec(line)![1]!] : []));
    return {
      title: lines.find((line) => line.trim())?.trim() ?? "",
      seniority: "",
      location: "",
      company: "",
      responsibilities: [],
      requirements: bullets.map((text) => ({ text, evidence: text, kind: BEHAVIOURAL.test(text) ? "behavioural" : "technical", priority: "must" })),
    };
  }

  if (system.startsWith("You write a short, factual company brief")) {
    const page = block(prompt, "company_page").split("\n").filter(Boolean);
    const stages = block(prompt, "hiring_page").split("\n").filter((line) => STAGE.test(line) && line.length < 200).slice(0, 5);
    return {
      summary: page.slice(1, 3).join(" ").slice(0, 400) || "A company.",
      what_they_do: page.slice(1, 2).join(" ").slice(0, 300),
      hiring_stages: stages.map((line) => line.split(/[.(]/)[0]!.trim()),
      interview_insights: [],
    };
  }

  if (system.startsWith("You write flashcards")) {
    return { flashcards: requirementLines(prompt).map(({ id, text }) => ({ front: `What would you say about: ${text}?`, back: `Two concrete examples and one trade-off involving ${text}.`, requirement_ids: [id] })) };
  }

  // Question generation, for any category and for gap-closing passes.
  const category = /You write ([a-z- ]+?) interview questions/.exec(system)?.[1] ?? "interview";
  const requirements = requirementLines(prompt);
  const stamp = Date.now().toString(36).slice(-4); // so a regeneration visibly differs from what it replaced
  if (requirements.length === 0) {
    return { questions: [{ requirement_ids: [], prompt: `Why this company, and why this role? (${stamp})`, answer_outline: "Motivation tied to what the company actually does.", difficulty: 1 }] };
  }
  return {
    questions: requirements.map(({ id, text }, index) => ({
      requirement_ids: [id],
      prompt: `${category[0]!.toUpperCase()}${category.slice(1)} question on "${text}" (${stamp})`,
      answer_outline: `Context, what you did, the trade-off, the result. Tie it back to ${text}.`,
      difficulty: (index % 3) + 1,
    })),
  };
}
