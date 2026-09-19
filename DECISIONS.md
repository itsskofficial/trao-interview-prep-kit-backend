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

## 12. One pipeline entry point, and sections degrade before the kit does

`buildKit` is the only path from a description to a kit; the API and `npm run evaluate` both call it. Inside it, a failed generation step costs its own section and leaves a note in the kit, while a model that is unavailable on every provider fails the case, because then there is no kit to give. Nothing leaves the pipeline without passing `validateKit`. The batch output file is written to a temporary name and renamed, so a crash cannot leave a half-written result.

## 13. The second pass: how many, when to stop, and a guarantee that does not depend on the model

Coverage is set arithmetic in code: a requirement is covered if some question lists its id. After the first draft, code finds the gaps and asks the model for questions covering those requirements only, by category, then checks again. `coverage.passes` counts checks, so a clean first draft is 1 and one gap-closing round is 2.

The loop stops on the first of: no must-have uncovered; a pass that closed nothing (asking the same model the same question again spends quota for the same answer); three checks. Three is enough because in practice a targeted "write one question for each of these" closes every gap in one round, and the free tier allows only ten calls per kit. Nice-to-have gaps get one attempt and are then reported in `uncovered_requirement_ids` rather than forced.

If a must-have is still uncovered after that, code writes a plain question from the requirement text, marked `origin: "fallback"`, and the kit notes it. The brief says a kit with an uncovered must-have "has failed at the one job it had", so that guarantee is enforced by code. A model error during gap-closing is treated as a pass that closed nothing, so it ends in fallbacks rather than a failed kit.

## 14. Fetched pages are untrusted from the first byte

The fetcher never throws: every problem is a typed skip reason (`invalid_url`, `blocked_address`, `robots_disallowed`, `http_error`, `timeout`, `network`, `unsupported_content_type`, `too_large`, `too_many_redirects`), so one bad source cannot fail a run and the reason can be shown to the user.

- **Addresses.** Scheme, embedded credentials and literal IPs are checked before any request. The real guard is in the socket's DNS lookup: the address actually being connected to is checked, which closes DNS rebinding (a hostname that validates and then resolves elsewhere) and covers every redirect hop. Private and loopback addresses are refused when `NODE_ENV=production` and allowed otherwise, because the evaluators serve company sites from localhost; `ALLOW_PRIVATE_URLS` forces either behaviour.
- **Redirects** are followed by hand, at most five, and each hop goes back through validation and robots.txt.
- **Limits.** HTML, XHTML, plain text and XML only; 1.5 MB enforced while streaming because Content-Length can lie; ten-second timeout.
- **Politeness.** robots.txt is read once per origin and obeyed. Requests to one host are serialised with a one-second gap (25 ms for loopback, where politeness only slows a local run). 429, 5xx, timeouts and network errors retry twice with backoff, honouring Retry-After.
- **Cleaning.** Scripts, styles, forms, comments and anything hidden by attribute or inline style are removed before text is taken, since that is where text aimed at a model gets planted. Links are collected first, with the region they were found in (nav, header, footer, body), and resolved against the page URL or its `<base>`, never against an assumed host.

Known limitation: pages that render only with JavaScript yield little text, because no browser is run. A hosted scraper was ruled out: it cannot reach a site served from the evaluator's localhost, and it would require a third API key.

## 15. Finding the hiring page: rank links, then let the page's own text decide

No path is assumed. Every same-origin link is scored in code from its anchor text (what the company chose to call the page), the words in its path, where it sits (navigation and footers get a point, since that is where Careers and About live) and its depth. Words about interviewing and hiring score highest, careers and jobs next, then handbook, people, culture and engineering pages, which are rarely the answer but are often one click from it. Legal pages, logins and files are dropped. The crawler always fetches the best-scoring unvisited link next, to depth two, within twelve pages, on the company's origin only. `sitemap.xml` beside the company URL is read when present and its entries are ranked the same way.

A link called "Careers" proves nothing, so a page counts as the hiring page only if its own text describes a process: at least three distinct process terms (recruiter, take-home, system design, on-site, final round, offer...) and one unambiguous anchor term such as "interview", because "round" and "stage" also describe funding. Links found on such a page inherit part of its score, which is how a vaguely named "What to expect" page two clicks down gets fetched. The crawl stops early once it has an unmistakable process page and an about page.

If the company URL itself fails, the site is recorded as unreachable. There is no fallback to the origin root: when several companies are served under one origin (as the evaluation fixtures may be), the root is a different site, and a brief about the wrong company is worse than an honest "could not be read".

The repository ships five fixture companies under `fixtures/sites` that mirror the published test set: a process two clicks deep at an unguessable path, a site with no hiring page, a process inside a blog post next to a JavaScript-only careers page and a robots-disallowed section, pages with planted instructions, and a site whose careers page answers 500.
