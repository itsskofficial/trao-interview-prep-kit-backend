import type { Kit, QuestionCategory, Requirement } from "../kit/schema";
import { wrapUntrusted } from "../llm/untrusted";
import { categoryFor } from "./questions";

export interface QuestionPlanInput {
  title: string;
  seniority: string;
  requirements: Requirement[];
  /** What the company publishes about its process. Empty when it publishes nothing. */
  hiringStages: string[];
  interviewInsights: string[];
  /** Undefined when nothing about the company could be retrieved. */
  brief?: Pick<Kit["company_brief"], "summary" | "what_they_do">;
}

export interface PlannedCall {
  category: QuestionCategory;
  requirements: Requirement[];
  guidance?: string;
  /** Why this call is being made, for the progress log. */
  reason: string;
}

const SENIOR = /\b(senior|staff|principal|lead|architect|head of)\b/i;
const DESIGN_REQUIREMENT = /\b(design|architect|architecture|distributed|scal(e|ing|able|ability)|event-driven|microservices?)\b/i;

const has = (stages: string[], pattern: RegExp) => stages.find((stage) => pattern.test(stage));

/**
 * Decides which question-generation calls to make, from what was actually
 * found. This is code, not a prompt: a company that publishes a take-home and
 * a system design round gets a different set of calls, with different
 * instructions, from one that publishes nothing.
 */
export function planQuestionCalls(input: QuestionPlanInput): PlannedCall[] {
  const { requirements, hiringStages: stages } = input;
  const technical = requirements.filter((r) => categoryFor(r) === "technical");
  const behavioural = requirements.filter((r) => categoryFor(r) === "behavioural");
  const calls: PlannedCall[] = [];

  if (technical.length > 0) {
    const takeHome = has(stages, /take[- ]?home|work sample|assignment|exercise|coding challenge/i);
    const live = has(stages, /pair|live coding|debugging|technical interview/i);
    calls.push({
      category: "technical",
      requirements: technical,
      reason: `${technical.length} technical or domain requirement(s)`,
      guidance: [
        takeHome && `The company's published process includes "${takeHome}". Make one question a small take-home style task, and say in its outline what a reviewer would look for.`,
        live && `The company's published process includes "${live}". Make one question a live scenario the candidate talks through while working.`,
      ].filter(Boolean).join("\n") || undefined,
    });
  }

  if (behavioural.length > 0) {
    const values = has(stages, /values|culture|behaviou?ral|hiring manager/i);
    calls.push({
      category: "behavioural",
      requirements: behavioural,
      reason: `${behavioural.length} behavioural requirement(s)`,
      guidance: values ? `The company's published process includes "${values}". Expect probing follow-ups on past situations; include them in the outlines.` : undefined,
    });
  }

  const designStage = has(stages, /system design|architecture|design interview/i);
  const designRequirements = technical.filter((r) => DESIGN_REQUIREMENT.test(r.text));
  const seniorRole = SENIOR.test(`${input.title} ${input.seniority}`);
  if (technical.length > 0 && (designStage || designRequirements.length > 0 || seniorRole)) {
    calls.push({
      category: "system-design",
      requirements: technical,
      reason: designStage ? `the company publishes a design round ("${designStage}")` : designRequirements.length > 0 ? "the posting asks for design experience" : "the role is senior",
      guidance: designStage ? `The company's published process includes "${designStage}". Shape the questions to that round.` : undefined,
    });
  }

  if (input.brief) {
    const known = [
      `Summary: ${input.brief.summary}`,
      `What they do: ${input.brief.what_they_do}`,
      stages.length > 0 ? `Published hiring stages: ${stages.join("; ")}` : "",
      input.interviewInsights.length > 0 ? `Public discussion of their interviews: ${input.interviewInsights.join("; ")}` : "",
    ].filter(Boolean).join("\n");
    calls.push({
      category: "company-fit",
      requirements: behavioural,
      reason: "company information was retrieved",
      guidance: `Base the questions on what is known about the company, and on nothing else.\n${wrapUntrusted("company_facts", known, 4_000)}`,
    });
  }

  return calls;
}
