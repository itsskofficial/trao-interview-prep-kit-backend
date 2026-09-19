import { z } from "zod";
import { PrioritySchema, RequirementKindSchema, type Requirement } from "../kit/schema";
import type { LlmClient } from "../llm/types";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../llm/untrusted";
import { isQuotedFrom, normalise, wordOverlap } from "./evidence";
import { decidePriority } from "./priority";

/** Below this many verified requirements the kit is reported as thin rather than padded. */
export const THIN_REQUIREMENT_COUNT = 3;

const ProposedRoleSchema = z.object({
  title: z.string(),
  seniority: z.string(),
  location: z.string(),
  company: z.string(),
  responsibilities: z.array(z.string()),
  requirements: z.array(
    z.object({
      text: z.string(),
      evidence: z.string(),
      kind: RequirementKindSchema,
      priority: PrioritySchema,
    }),
  ),
});

export interface ExtractedRole {
  title: string;
  seniority: string;
  location: string;
  company: string;
  responsibilities: string[];
  requirements: Requirement[];
  /** True when the description gave too little to build a full kit from. */
  thin: boolean;
  /** Requirements the model proposed that the description does not contain. */
  rejected: Array<{ text: string; reason: string }>;
}

export class EmptyDescriptionError extends Error {
  constructor() {
    super("The job description is empty.");
    this.name = "EmptyDescriptionError";
  }
}

const SYSTEM = `You read one job description and report what it says. You never add to it.

Rules:
- A requirement is a skill, experience, qualification or trait the posting asks the candidate to have.
- Report only requirements the text states. If it states few, report few. An empty list is a valid answer.
- "evidence" is the exact words copied from the description that state the requirement, character for character. Never paraphrase it.
- "text" is a short restatement using the description's own terms, e.g. "5+ years with React".
- One requirement per distinct skill or trait. Split "React and TypeScript" only if the posting lists them separately.
- "kind": technical for tools, languages and engineering skills; behavioural for how someone works with people; domain for industry or subject knowledge.
- "priority": must if the posting words it as required, nice if it words it as a bonus or preference.
- "responsibilities" are what the person will do, in the posting's own words.
- title is the job title exactly as written, including any seniority word in it ("Senior Backend Engineer", not "Backend Engineer").
- seniority, location and company: copy them if stated, otherwise use an empty string. Never guess.
- ${UNTRUSTED_CONTENT_RULE}`;

/**
 * The model proposes; this function decides. A requirement survives only if
 * its evidence is really in the description, and must/nice comes from the
 * posting's wording. Inventing a requirement is the worst failure a prep kit
 * can have, so it is not left to a prompt.
 */
export async function extractRole(description: string, llm: LlmClient): Promise<ExtractedRole> {
  if (description.trim().length === 0) throw new EmptyDescriptionError();

  const proposed = await llm.generate({
    step: "extract-requirements",
    system: SYSTEM,
    prompt: `Extract the role and its requirements.\n\n${wrapUntrusted("job_description", description)}`,
    schema: ProposedRoleSchema,
  });

  const rejected: ExtractedRole["rejected"] = [];
  const verified: Array<Omit<Requirement, "id"> & { position: number }> = [];
  const haystack = normalise(description);

  for (const candidate of proposed.requirements) {
    if (!isQuotedFrom(description, candidate.evidence)) {
      rejected.push({ text: candidate.text, reason: "evidence is not in the job description" });
      continue;
    }
    const evidence = candidate.evidence.trim();
    // The restatement must stay on the evidence; if it drifts, the posting's own words are used instead.
    const text = wordOverlap(candidate.text, evidence) >= 0.5 ? candidate.text.trim() : evidence;
    if (verified.some((existing) => normalise(existing.text) === normalise(text))) continue;

    verified.push({
      text,
      evidence,
      kind: candidate.kind,
      priority: decidePriority(description, evidence, candidate.priority),
      position: haystack.indexOf(normalise(evidence)),
    });
  }

  // Ids follow the order of the posting, so the same description always yields the same ids.
  const requirements = verified
    .sort((a, b) => a.position - b.position)
    .map(({ position: _position, ...requirement }, index) => ({ id: `r${index + 1}`, ...requirement }));

  const stated = (value: string) => (isQuotedFrom(description, value) ? value.trim() : "");

  return {
    title: proposed.title.trim(),
    seniority: stated(proposed.seniority),
    location: stated(proposed.location),
    company: stated(proposed.company),
    responsibilities: proposed.responsibilities.map((r) => r.trim()).filter((r) => wordOverlap(r, description) >= 0.6),
    requirements,
    thin: requirements.length < THIN_REQUIREMENT_COUNT,
    rejected,
  };
}
