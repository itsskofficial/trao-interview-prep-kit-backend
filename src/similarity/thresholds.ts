/**
 * Chosen from `npm run calibrate` over the labelled pairs in fixtures/similarity.json, whose negatives
 * are deliberately hard. Measured on 2026-09-20 with gemini-embedding-2 (768 dimensions,
 * plain text). Re-run the script after changing the embedding model.
 *
 * Request format. This model ignores `taskType`: vectors were identical with and without it. Its documented
 * task prefix ("task: sentence similarity | query: ...") was measured too and made things worse for this job:
 * paraphrases rose to 0.90-0.98 but the closest pair of different questions rose further, to 0.93, above the
 * lowest paraphrase. Plain text kept them apart (0.894 against 0.887), so plain text is what is sent.
 *
 * Duplicate questions. Paraphrases scored 0.89-0.95, but so did different questions about the same
 * subject (a memory leak in Node.js and one on the JVM), so no threshold separates them: 0.90 gave
 * precision 0.92, and precision 1.00 only came at 0.92 with recall 0.43. Hence the second, plain
 * condition in duplicates.ts: two questions that each name a technology the other does not are
 * different questions. With it, 0.90 made no mistake on the set and found 12 of 14 paraphrases.
 * Wrongly removing a question costs the user something and keeping a duplicate costs a slot, so
 * the threshold is the lowest that made no mistake. Lexical vectors only recognise near-verbatim
 * repeats (no mistakes from 0.64, 1 of 14 paraphrases found), which is all the fallback claims to do.
 *
 * Claim supported by its quote. Supported pairs scored 0.69-0.85. Unrelated sentences scored
 * 0.59-0.65 and are all refused at 0.68, including "Coding challenge on HackerRank" pinned on a
 * sentence about a take-home project (0.62), while "Take-home exercise" on that sentence is kept (0.69).
 * Sentences written to share the claim's words ("our design system", "we offer competitive pay")
 * scored 0.69-0.80 and half of them pass. Meaning alone cannot close that gap, which is why this
 * check is the third line of defence and not the first: the quote must be verbatim from a page
 * that code has already accepted as a hiring page, and cited by the model for that one claim.
 */
export const DUPLICATE_THRESHOLD = { semantic: 0.9, lexical: 0.64 } as const;

/** `lexicalOverlap` is the share of the claim's significant words that must appear in its quote when no semantic comparison is available. */
export const SUPPORT_THRESHOLD = { semantic: 0.68, lexicalOverlap: 0.34 } as const;
