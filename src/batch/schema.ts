import { z } from "zod";
import { KitSchema } from "../kit/schema";

/** Appendix B: the file given to `npm run evaluate`, and the file it writes. */

export const MAX_DAYS = 365;

/** Forgiving about how the file was produced: a numeric id or "5" for days is not a reason to fail a case. */
export const CaseInputSchema = z.object({
  id: z.union([z.string().min(1), z.number()]).transform(String),
  jd: z.string(),
  company_url: z.string(),
  days: z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(1).max(MAX_DAYS)),
});

/** Entries are validated one by one, so a malformed case fails alone instead of aborting the run. */
export const BatchInputSchema = z.array(z.unknown());

/** `failed` is reserved for a case with no kit at all; partial research is still `ok`. */
export const CaseErrorCodeSchema = z.enum([
  "INVALID_INPUT",
  "JD_EMPTY",
  "LLM_UNAVAILABLE",
  "KIT_INVALID",
  "TIMEOUT",
  "INTERNAL",
]);

export const CaseErrorSchema = z.object({
  code: CaseErrorCodeSchema,
  message: z.string().min(1),
});

export const CaseResultSchema = z.discriminatedUnion("status", [
  z.object({ id: z.string(), status: z.literal("ok"), kit: KitSchema, error: z.null() }),
  z.object({ id: z.string(), status: z.literal("failed"), kit: z.null(), error: CaseErrorSchema }),
]);

export const BatchOutputSchema = z.object({
  version: z.literal("1.0"),
  generated_at: z.string().min(1),
  kits: z.array(CaseResultSchema),
});

export type CaseInput = z.infer<typeof CaseInputSchema>;
export type CaseErrorCode = z.infer<typeof CaseErrorCodeSchema>;
export type CaseError = z.infer<typeof CaseErrorSchema>;
export type CaseResult = z.infer<typeof CaseResultSchema>;
export type BatchOutput = z.infer<typeof BatchOutputSchema>;
