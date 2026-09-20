import { z } from "zod";
import type { Flashcard, Requirement } from "../kit/schema";
import type { LlmClient } from "../llm/types";
import { UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../llm/untrusted";

const ProposedFlashcardsSchema = z.object({
  flashcards: z.array(z.object({ front: z.string().min(1), back: z.string().min(1), requirement_ids: z.array(z.string()) })),
});

export type DraftFlashcard = Omit<Flashcard, "id">;

export const SYSTEM = `You write flashcards for quick recall practice before an interview.

Rules:
- "front" is one short question or cue. "back" is the answer in one to three sentences.
- Cards test concepts, terms and trade-offs behind the listed requirements: things that can be recalled, not essays.
- Every card lists the requirement ids it helps with. Use only the ids you are given.
- If company facts are supplied, add up to three cards on them (what the company does, its hiring stages) with an empty requirement id list. Use only the supplied facts.
- ${UNTRUSTED_CONTENT_RULE}`;

export interface FlashcardInput {
  roleTitle: string;
  requirements: Requirement[];
  /** Short facts about the company and its process, already verified upstream. Empty when nothing is known. */
  companyFacts: string[];
}

export async function generateFlashcards(input: FlashcardInput, llm: LlmClient): Promise<DraftFlashcard[]> {
  const { requirements, companyFacts } = input;
  if (requirements.length === 0 && companyFacts.length === 0) return [];

  const target = Math.min(20, Math.max(4, Math.ceil(requirements.length * 1.5)));
  const proposed = await llm.generate({
    step: "flashcards",
    system: SYSTEM,
    prompt: [
      `Role: ${input.roleTitle || "not stated"}`,
      `Write about ${target} flashcards. Give every [must] requirement at least one.`,
      requirements.length > 0 ? wrapUntrusted("requirements", requirements.map((r) => `${r.id} [${r.priority}] ${r.text}`).join("\n")) : "",
      companyFacts.length > 0 ? wrapUntrusted("company_facts", companyFacts.join("\n"), 3_000) : "",
    ].filter(Boolean).join("\n\n"),
    schema: ProposedFlashcardsSchema,
  });

  const known = new Set(requirements.map((r) => r.id));
  return proposed.flashcards.map((card) => ({
    front: card.front.trim(),
    back: card.back.trim(),
    requirement_ids: [...new Set(card.requirement_ids.filter((id) => known.has(id)))],
    origin: "generated" as const,
  }));
}
