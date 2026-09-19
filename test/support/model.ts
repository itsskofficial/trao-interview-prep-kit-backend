import { fakeLlmClient } from "../../src/llm/fake";
import type { LlmClient, LlmProvider, ProviderRequest } from "../../src/llm/types";

export type ModelRoute = "extract" | "brief" | "technical" | "behavioural" | "system-design" | "company-fit" | "gaps" | "flashcards";

type Answer = object | Error | ((request: ProviderRequest) => object);

/** Which pipeline step is asking, judged from the request the way a reader would. */
export function routeOf(request: ProviderRequest): ModelRoute {
  if (request.prompt.includes("have no question yet")) return "gaps";
  if (request.system.startsWith("You read one job description")) return "extract";
  if (request.system.startsWith("You write a short, factual company brief")) return "brief";
  if (request.system.startsWith("You write flashcards")) return "flashcards";
  if (request.system.startsWith("You write technical")) return "technical";
  if (request.system.startsWith("You write behavioural")) return "behavioural";
  if (request.system.startsWith("You write system design")) return "system-design";
  if (request.system.startsWith("You write company-fit")) return "company-fit";
  throw new Error(`Unrecognised model request: ${request.system.slice(0, 60)}`);
}

const requirementIds = (request: ProviderRequest) => [...request.prompt.matchAll(/^(r\d+) \[/gm)].map((match) => match[1]!);

/** One question per requirement listed in the prompt. */
export const oneQuestionPerRequirement = (request: ProviderRequest) => ({
  questions: requirementIds(request).map((id) => ({ requirement_ids: [id], prompt: `Question about ${id}`, answer_outline: "Outline", difficulty: 2 })),
});

const DEFAULTS: Record<ModelRoute, Answer> = {
  extract: { title: "", seniority: "", location: "", company: "", responsibilities: [], requirements: [] },
  brief: { summary: "A company.", what_they_do: "Things.", hiring_stages: [], interview_insights: [] },
  technical: oneQuestionPerRequirement,
  behavioural: oneQuestionPerRequirement,
  "system-design": (request) => ({ questions: [{ requirement_ids: requirementIds(request).slice(0, 2), prompt: "Design a system", answer_outline: "Components", difficulty: 3 }] }),
  "company-fit": { questions: [{ requirement_ids: [], prompt: "Why this company?", answer_outline: "Motivation", difficulty: 1 }] },
  gaps: oneQuestionPerRequirement,
  flashcards: (request) => ({ flashcards: requirementIds(request).map((id) => ({ front: `Front ${id}`, back: "Back", requirement_ids: [id] })) }),
};

/**
 * A model stub that answers by step rather than by call order, so a test says
 * only what it cares about. An array is consumed one answer per call, the last
 * one repeating.
 */
export function routedModel(routes: Partial<Record<ModelRoute, Answer | Answer[]>> = {}) {
  const requests: Array<ProviderRequest & { route: ModelRoute }> = [];
  const queues = new Map<ModelRoute, Answer[]>();
  for (const [route, answer] of Object.entries(routes)) queues.set(route as ModelRoute, Array.isArray(answer) ? [...answer] : [answer]);

  const provider: LlmProvider = {
    name: "routed-fake",
    async complete(request) {
      const route = routeOf(request);
      requests.push({ ...request, route });
      const queue = queues.get(route);
      const answer = (queue && queue.length > 1 ? queue.shift() : queue?.[0]) ?? DEFAULTS[route];
      if (answer instanceof Error) throw answer;
      return { text: JSON.stringify(typeof answer === "function" ? answer(request) : answer) };
    },
  };

  const llm: LlmClient = fakeLlmClient([provider], { maxRetries: 0 });
  return { llm, requests, routes: () => requests.map((request) => request.route), requestFor: (route: ModelRoute) => requests.find((r) => r.route === route) };
}
