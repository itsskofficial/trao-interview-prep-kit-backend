import { createHash } from "node:crypto";
import { SYSTEM as EXTRACTION } from "../extraction/extract";
import { SYSTEM as BRIEF } from "../generation/brief";
import { SYSTEM as FLASHCARDS } from "../generation/flashcards";
import { CATEGORY_BRIEF, SHARED_RULES } from "../generation/questions";

/** Bumped when the pipeline's steps or their order change. Prompt changes are tracked by the fingerprint instead. */
export const PIPELINE_VERSION = "2.0.0";

/** Every instruction the pipeline gives a model. A prompt added to the pipeline is added here. */
export function pipelinePrompts(): string[] {
  return [EXTRACTION, BRIEF, FLASHCARDS, SHARED_RULES, ...Object.values(CATEGORY_BRIEF)];
}

/**
 * A short hash over every system prompt. Nobody has to remember to bump a
 * version: edit a prompt and kits made afterwards carry a different value.
 */
export function promptFingerprint(prompts: string[] = pipelinePrompts()): string {
  const hash = createHash("sha256");
  for (const prompt of prompts) hash.update(prompt).update("\u0000");
  return hash.digest("hex").slice(0, 12);
}
