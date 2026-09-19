# Decisions

A running log of the judgement calls in this project and why each was made. Newest at the bottom.

## 1. An unreachable company site is `ok`, not `failed`

The brief's Appendix B example shows `COMPANY_UNREACHABLE` as a failed case, but its FAQ says to reserve `failed` for "a case you could not produce a kit for at all", and the scoring rewards unreachable sites being "recorded rather than fatal". A job description alone is enough for requirements, questions, flashcards and a schedule. So a dead URL produces an `ok` kit whose brief says the site could not be retrieved, with the attempt in `research_log`. `failed` is kept for an empty description or the model being unavailable on every provider.

## 2. The model proposes requirements; code decides whether they exist

Every extracted requirement must carry a verbatim evidence quote. Code checks the quote appears in the job description and drops the requirement if it does not. `must` or `nice` is decided by code from the wording of that line and its heading. Inventing a requirement is the worst failure the brief names, so it is not left to a prompt.

## 3. LLM: `gemini-3.5-flash-lite`, with Groq as fallback

Measured on a free-tier key on 2026-09-19: every full Gemini Flash model allows 20 requests per day, which is two kits. Flash-Lite allows 15 requests/min, 250K tokens/min and 500 requests/day. Groq's free tier allows 8K tokens/min, which is too slow as a primary for five cases in fifteen minutes but fine as a fallback. The budget is at most ten model calls per kit.

## 4. One Zod schema for the kit, and validation that reports everything

The kit schema is defined once and used for model output, the assembled kit and the batch file. `validateKit` checks shape and then internal references (requirement ids, question ids, day count and numbering) and returns every problem at once, so a bad model response can be repaired in a single retry. Extensions (`origin`, `edited`, `pinned`, `evidence`, `hiring_stages`, `research_log`, `notes`) are optional so a bare Appendix A kit still validates.

## 5. Batch input is validated per case

The input file is parsed as an array of unknowns and each entry is validated on its own, so one malformed case becomes one `failed` entry instead of aborting the run.

## 6. Rate limits are respected before the call, not discovered from a 429

A sliding one-minute limiter counts both requests and estimated tokens before anything is sent, with defaults set below the measured free-tier limits. When a 429 still arrives, the provider's own `Retry-After` wins over our backoff. A per-minute limit means wait; an exhausted per-day quota means fail over to the next provider, because waiting a minute will not help. The Gemini provider tells the two apart from the quota id in the error body.

## 7. One repair attempt for invalid model output, then a structured error

Output is parsed leniently (code fences and surrounding prose are tolerated) and then validated against the step's Zod schema. On failure the model is shown the exact validation issues once. A second failure raises `LLM_INVALID_OUTPUT`; the pipeline decides whether that step can degrade. Retrying more than once spends quota on a model that is unlikely to change its mind.

## 8. Minimal thinking on Gemini

`thinkingLevel: "minimal"` cut a structured call from about 13s to 3–8s in measurement. Extraction and drafting do not need long reasoning, and latency decides whether five cases fit in fifteen minutes.

## 9. How extraction refuses to invent

The model returns each requirement with a verbatim `evidence` quote. Code then: (a) drops the requirement if the quote is not in the description, comparing with whitespace, case and typographic quotes normalised; (b) replaces the model's restatement with the posting's own words if fewer than half of its significant words appear in the evidence; (c) blanks seniority, location and company unless the description states them; (d) drops responsibilities whose words are not in the description; (e) numbers requirements in posting order so ids are stable. Fewer than three verified requirements marks the kit as thin. A live run ignored an "ignore all previous instructions" line planted in a posting, but the design does not rely on that: nothing a page or posting says can change the output shape, and requirements only ever come from verified quotes.

## 10. Must or nice is decided by wording, in a fixed order

Bonus phrases are checked before required phrases, and scope narrows from the evidence, to its sentence, to the heading above it. So "Rust is a plus" under a Requirements heading is nice, "a work permit is required" under Nice to have is must, and a one-line stub ("Required: React. Bonus: GraphQL.") is split by sentence. Loose phrases like "you have" count only in headings. The model's label is the last resort.

## 11. The schedule is a ranking dealt out across days

No model is involved. Questions are ranked must-have first, then hardest first, then original order, and that ranking is cut into contiguous slices across exactly the requested days, leftovers going to the earliest days. So the hardest must-have material is day 1 and the last day is the easiest nice-to-have material. Every question is scheduled, which means every covered must-have requirement appears. Minutes are 10, 15 or 20 per question by difficulty, with a 30-minute floor per day, so they are always integers. With more days than questions (a 60-day schedule), the extra days are revision days that walk the same ranking again at half the time per question, rather than sitting empty or spreading one question a day thinly to the end. With zero questions every day still exists and says so.
