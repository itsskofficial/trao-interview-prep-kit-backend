# Decisions

The project's decision log (its ADRs, kept in one file so they can be read in order): each entry is the situation, the decision and the reason, written as the work happened. Newest at the bottom.

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
- **Limits.** HTML, XHTML, plain text and XML only; ten-second timeout. A page is read up to 3 MB and used as far as it got, with the limit enforced while streaming because Content-Length can lie; only something announcing itself as over 12 MB is refused outright. The first live run on the deployed app showed why: posthog.com's homepage is over 1.5 MB of markup, and the original hard cap threw the whole site away, when the words a person reads are near the top.
- **Politeness.** robots.txt is read once per origin and obeyed. Requests to one host are serialised with a one-second gap (25 ms for loopback, where politeness only slows a local run). 429, 5xx, timeouts and network errors retry twice with backoff, honouring Retry-After.
- **Cleaning.** Scripts, styles, forms, comments and anything hidden by attribute or inline style are removed before text is taken, since that is where text aimed at a model gets planted. Links are collected first, with the region they were found in (nav, header, footer, body), and resolved against the page URL or its `<base>`, never against an assumed host.

Known limitation: pages that render only with JavaScript yield little text, because no browser is run. A hosted scraper was ruled out: it cannot reach a site served from the evaluator's localhost, and it would require a third API key.

## 15. Finding the hiring page: rank links, then let the page's own text decide

No path is assumed. Every same-origin link is scored in code from its anchor text (what the company chose to call the page), the words in its path, where it sits (navigation and footers get a point, since that is where Careers and About live) and its depth. Words about interviewing and hiring score highest, careers and jobs next, then handbook, people, culture and engineering pages, which are rarely the answer but are often one click from it. Legal pages, logins and files are dropped. The crawler always fetches the best-scoring unvisited link next, to depth two, within twelve pages, on the company's origin only. `sitemap.xml` beside the company URL is read when present and its entries are ranked the same way.

A link called "Careers" proves nothing, so a page counts as the hiring page only if its own text describes a process: at least three distinct process terms (recruiter, take-home, system design, on-site, final round, offer...) and one unambiguous anchor term such as "interview", because "round" and "stage" also describe funding. Links found on such a page inherit part of its score, which is how a vaguely named "What to expect" page two clicks down gets fetched. The crawl stops early once it has an unmistakable process page and an about page.

If the company URL itself fails, the site is recorded as unreachable. There is no fallback to the origin root: when several companies are served under one origin (as the evaluation fixtures may be), the root is a different site, and a brief about the wrong company is worse than an honest "could not be read".

The repository ships five fixture companies under `fixtures/sites` that mirror the published test set: a process two clicks deep at an unguessable path, a site with no hiring page, a process inside a blog post next to a JavaScript-only careers page and a robots-disallowed section, pages with planted instructions, and a site whose careers page answers 500.

## 16. The brief is written from what was retrieved, or not by the model at all

One model call turns the homepage, the about page, the hiring page and any relevant public discussion into a summary, what the company does, the hiring stages and interview insights. Then the same rule as for requirements applies: a stage survives only if at least half of its significant words appear in the hiring page, and an insight only if they appear in the discussion text. With no hiring page, stages are forced empty whatever the model says. With nothing retrieved at all, no call is made: code writes a brief that says nothing could be found and why, because a model handed a company name and an empty page will describe the company anyway.

`company_brief.sources` lists a URL only if something from it ended up in the kit. A live run showed why: searching Hacker News for a fixture company called Hooli returned three hits that named it and mentioned interviews, all about a television show. The model correctly used none of them, so they are not cited, and the research log says that results matched the name but were not about this company.

## 17. Public discussion: two official APIs, and two obvious sources left out

Hacker News (Algolia API) and Stack Exchange Workplace, both keyless and open to programmatic use, queried for the exact company name plus "interview", through the same fetcher as everything else (robots.txt, limits, timeout). A hit is kept only if it names the company and uses interviewing vocabulary. Reddit and Glassdoor are where most of this discussion lives, but their robots.txt and terms forbid unauthenticated automated access, and the brief says to respect both. Each source is logged as used, empty or skipped, and none can fail a run. The search needs a company name, which often only becomes known from the crawl, which is why it runs after it.

## 18. Which question calls are made is decided by code, from what was found

`planQuestionCalls` is a pure function from (requirements, seniority, published stages, brief) to a list of calls, each with its own category instructions, its own subset of requirements and its own guidance:

- technical: technical and domain requirements. A published take-home adds "make one question a take-home style task"; pair programming or a live technical interview adds a live scenario.
- behavioural: behavioural requirements only. A published values or hiring-manager round adds probing follow-ups.
- system-design: only if the company publishes a design round, the posting asks for design experience, or the role is senior.
- company-fit: only if something about the company was actually retrieved; its questions may stand without a requirement.

So a company that publishes a take-home and a design round gets different calls with different instructions from one that says nothing, and a dead company URL gets no company-fit call at all. A typical kit costs seven model calls (extract, brief, up to four categories, flashcards) plus one per category with gaps. After extraction no step can fail the kit: a failed section leaves a note and an empty section, and if every question call failed, the coverage backstop would still cover every must-have.

## 19. Two providers, and a batch that cannot hang

`LLM_PROVIDER` picks who goes first; the other provider is used only if a key for it is set, when the first runs out of daily quota or fails outright. Evaluators can therefore run with whichever free key they have. Each provider has its own limiter, because their limits differ by an order of magnitude (Gemini Flash-Lite: 250K tokens/min; Groq: 8K).

The batch runs two cases at a time, but it is the shared limiter that paces them: measured on the free tier, five fixture cases (37 model calls, 25 pages) take about 2 minutes 20 seconds whether run one or two at a time, because twelve requests a minute is the ceiling. Concurrency still helps when one case is waiting on a slow site. Each case has a 170-second budget and is recorded as `TIMEOUT` if it overruns, so one hung site cannot cost the fifteen minutes. Identical cases (same description, company and days) are researched once and share the result. Results are written in input order.

## 20. Authentication kept minimal, and ownership made impossible to forget

Passwords are hashed with bcrypt (cost 12; passwords over 72 bytes are refused rather than silently truncated). A session is a seven-day HS256 JWT in an `httpOnly`, `SameSite=Lax` cookie, `Secure` in production. The Next.js app proxies `/api/*` to this server, so the cookie is first-party and survives browsers that block third-party cookies; `SameSite=Lax` plus JSON-only bodies covers cross-site request forgery. Scripts cannot read the cookie, which is the reason not to keep a token in `localStorage`. The verifier accepts HS256 only, so an unsigned (`alg: none`) token is rejected. A 401 says whether the session is `SESSION_EXPIRED` or `UNAUTHENTICATED` so the interface can say "sign in again" instead of looking broken. Sign-in gives the same answer, in the same time, for a wrong password and an unknown email, and auth routes are rate limited. In production the server refuses to start with a missing or short `JWT_SECRET`.

Kits are reached only through a repository whose every method takes the owner's id; there is no "load by id" to misuse. Someone else's kit and a kit that does not exist both answer 404, so ids cannot be probed. Every error, including malformed JSON and oversized bodies, has the shape `{ error: { code, message, details? } }`.

## 21. Generation is a job, not a request

Generation takes one to two minutes, depends on other people's servers and can fail halfway, so the request that starts it returns at once (`202` with a job) and the work runs in an in-process runner, two jobs at a time, calling the same `buildKit` as the batch command. Everything the job does is written to its document, and the interface polls it. Polling was chosen over server-sent events because it survives free-tier proxies, sleeping instances and a closed laptop lid, and the job can be reopened from any device. Progress writes for one job are chained, because independent writes to the same document can land out of order (a test caught exactly that).

**Triggered twice.** A posting is identified by a hash of its normalised description and company URL (whitespace, letter case and a trailing slash ignored; days excluded, since a new deadline is not a new kit). While a job for that posting is queued or running, a second submission gets the same job back. That is enforced by a partial unique index on `(userId, fingerprint)` where `active` is true, so two requests racing past the application check still cannot both insert. Once a kit exists the answer is `kit_exists` with its id, and a new one is generated only when the request says `fresh: true`.

**Fails halfway.** Only extraction can fail a job (see decision 12); the job then stores `{ code, message }` and can be retried in place. **Server restarts.** Jobs live in this process, so on boot anything still marked active is set to `interrupted` with an explanation and becomes retryable. That is the honest answer for a single free instance; an external queue would survive restarts, and is the first thing to add with a second instance.

**Several roles at once.** `POST /api/jobs/batch` takes the same case shape as the batch command, at most ten. Each case is validated on its own, so one bad entry is reported beside the others instead of rejecting the file.

## 22. Generated, edited and pinned: how a regeneration cannot clobber work

**State.** Every question, flashcard and the brief carry three optional fields. `origin` is where the item came from: `generated`, `user`, or `fallback` (written by code to guarantee coverage). `edited` is set the moment the user changes the item's content and is never cleared. `pinned` is the user saying "keep this"; moving a question to another category pins it, because that is a deliberate act. An item is *protected* if it is user-written, edited or pinned. That single predicate is the whole rule: regeneration never removes, rewrites or reorders a protected item.

**Changes are operations, not documents.** The interface never sends the kit back. Each change is one small request naming one thing (patch this question, reorder this category, pin that card), implemented as a pure function from kit to kit in `builder/operations.ts`. A no-op patch does not mark anything edited. After any change to the questions, coverage and the schedule are recomputed by code, so the kit can never reference a question that no longer exists. Ids come from counters stored beside the kit that only go up, so an id is never reused, even after a delete or an undone regeneration.

**One way to save.** `kits.mutate` loads the kit, applies a pure change, validates the result against the schema, and saves only if the stored `version` is still the one it read; otherwise it re-runs the change on the newer kit. Five edits fired at the same instant all land (there is a test for exactly that), and nothing is ever saved without passing validation.

**Regeneration merges into the kit as it is when the model answers, not as it was when it was asked.** `POST /regenerate` marks the kit as regenerating and returns 202. The model call runs in the background with a note of which questions the user is keeping, so it writes different ones. Its result goes through the same `mutate`, so the merge sees every edit made in the meantime. A question the user started typing in ten seconds ago is already `edited`, therefore protected, therefore kept; tests hold the model back, edit in the same category and elsewhere, then release it. Within the category, protected questions keep their slots, new questions fill the freed slots, and other categories are not read or rewritten (a test compares them byte for byte). If the swap left a must-have uncovered, code adds a fallback question, so the coverage guarantee survives regeneration. If the model fails or returns nothing, the kit is untouched and the failure is shown. The schedule "regenerates" instantly because it is arithmetic.

**The brief** is one item, so a brief the user has edited or pinned is not silently replaced: the API answers `BRIEF_PROTECTED` and the interface asks first. If the user edits the brief while a new one is being written, their text wins.

**Undo.** A regeneration stores what it removed and what it added; one action puts the old questions back with their original ids and removes the new ones, except any the user has since edited or pinned. Only the latest regeneration is kept, which is what someone who just lost a question they liked needs.

Not done: per-field tracking (editing a prompt protects the whole question, including its outline). It would let an outline refresh under an edited prompt, at the cost of a merge that is much harder to explain and to trust.

## 23. Practice: Leitner boxes, and a weak-spots report that can re-plan the schedule

Each flashcard sits in one of five boxes. After a card the user says how confident they felt: 1 "no idea" sends it back to box 1, 2 "shaky" down one, 3 "mostly" up one, 4 "confident" up two. The next session is the cards never seen, then the lowest box, then the card seen longest ago, with ties in the kit's own order so it is deterministic. Covered means seen at least once; mastered means box 4 or 5. SM-2 style intervals were rejected on purpose: they schedule reviews days and weeks out, and someone with an interview in five days needs "what am I worst at right now", which is what the lowest box is. A plain confidence sort was rejected because it forgets history: one lucky answer would hide a card that failed three times.

Progress is stored beside the kit, not inside it: it is the user's state, and the kit structure stays exactly what Appendix A describes.

**Creative feature: weak spots, then re-plan.** Practice results are mapped back through `requirement_ids` to the posting's requirements: must-haves first, then the most weak cards, each with the questions that cover it. A card is weak when the user's latest answer on it was "no idea" or "shaky"; a card answered "mostly" on first sight sits in a low box but is not a weak spot, and a card never seen is "not covered", not "weak" (a test caught the first version getting this wrong). One action then re-plans the schedule from a chosen day: days already done are kept, and every question is dealt out again over the remaining days with the weak-spot questions first. It reuses the same deterministic allocator, so the schedule still spans exactly the requested days and still schedules every question. The re-plan is stored in the kit (`schedule.replan`), so later edits keep it and deleted questions drop out of it; regenerating the schedule returns to the default plan. The problem it solves is the real one two days before an interview: the plan made on day one no longer matches what you turned out not to know.

## 24. Scoring ourselves against the published rubric before anyone else does

`npm run selfcheck` runs the batch pipeline over the five fixture companies with a live model and scores the output against the brief's automated rubric: must-haves found and marked correctly with nothing invented, every must-have covered, the schedule spanning exactly the requested days and allocating every question, the research steps evidenced in the kit, structure valid, run inside fifteen minutes. Expected must-haves live beside each case in `fixtures/expected.json`, so extraction is measured rather than eyeballed. The last live run scored 35/35 extraction checks, 31/31 research, 13/13 robustness and found one fault, which was in the check itself (with a one-day schedule everything is on day 1, so the claim has to be about what comes first). `--from <kits.json>` re-scores a saved output without spending model requests.

## 25. A public deployment on a shared free quota needs an allowance per account

The live app is open to anyone, and every kit or regeneration spends requests from one free-tier model quota. Left alone, one account could use the day's 500 requests and the evaluators would find an app that cannot generate. Each account therefore gets an hourly allowance of generations and regenerations (15 by default) and a cap on kits generating at once (5). Going over answers 429 with how many were used and roughly when to try again. Only work that will really call the model is charged: a duplicate posting, an existing kit and a schedule regeneration cost nothing. In a batch upload the cases over the allowance are reported as `limited` beside the ones that started. Usage entries expire through a TTL index, so nothing needs cleaning up. `GET /api/kits/:id/export` downloads a kit alone, in exactly the Appendix A structure.

## 26. The model sees the lines of a hiring page that are about hiring, not its first six thousand characters

The first live run against PostHog found their hiring-process page by crawling (`/handbook/people/hiring-process`, the kind of path the brief says cannot be predicted) and then extracted no stages from it. The page is about 39,000 characters, and the candidate-facing stages start two thirds of the way down, after the company's approach to hiring and instructions for its own recruiters; the brief step had been given only the top. A sliding window over the densest stretch was tried next and also failed: on that page the densest stretch is about booking interviews in their applicant-tracking system. What works is a digest: from the whole page, in page order, keep the lines that mention process terms at all, weighting terms that name a stage outright ("technical interview", "take-home", "SuperDay", "offer") three times as much as words that merely turn up around hiring, and when that is still too long drop the lines that say least. Grounding is unchanged: every stage the model reports must still be traceable to the page's full text. Page text is now kept up to 80,000 characters for this reason.

## 27. An independent review before submission, and what it found

Two reviewers that had not written the code read each repository against its README, with instructions to report only defects they could trace to a failing scenario. They found twenty-four; all were fixed, each with a test named after its scenario (`test/extraction-hardening.test.ts`, `test/crawl-hardening.test.ts`, `test/review-fixes.test.ts`). The ones that would have cost automated points:

- **Evidence matching was too literal.** `**React**,` normalised to `react ,` and no longer matched the model's quote, so a must-have was silently dropped; backticks, link syntax, ellipses and zero-width characters had the same effect. Markup is now deleted rather than replaced by a space, and a long quote falls back to comparing letters and digits alone.
- **Short evidence matched inside other words.** "Go" was found in "good", which both verified an invented requirement and read its priority from the wrong line. Matching is now by whole word, with `c++`, `c#` and `.net` counted as words, and a list item that is exactly the evidence beats a sentence that mentions it.
- **Mixed wording.** "Bachelor's degree required, Master's preferred" came out as nice, and "is a big plus" as must. The earlier signal now wins, and bonus wording is matched by pattern ("a strong plus") without catching "Python plus SQL".
- **The crawl was scoped by origin.** On a host serving several companies, a link from `/acme/` to `../globex/careers.html` made Globex's process Acme's. The scope is now the company's own folder, including after a redirect, and the sitemap is looked for inside it.
- **Substring process terms.** "around", "background" and "we offer" made a plain careers page a hiring page, which suppressed the honest "does not publish how it hires" note.
- **Unbounded attempts.** The page budget counted successes only, so a site whose links all failed could be tried hundreds of times and turn an `ok` kit into a `TIMEOUT`.
- **A timed-out case kept running**, holding slots in the shared rate limiter ahead of the cases after it. It is now told to stop.
- **The CLI** died on a byte-order mark, and wrote nothing until every case had finished.

Others: the hourly allowance could be passed by parallel requests (it now writes the charge first and counts second), charged for regenerations it then refused, and did not charge retries; a forced brief regeneration overwrote text typed while it ran; Groq's free tier could not finish a case inside the default budget, and the README said otherwise. The review also confirmed what held: the SSRF guard against mapped, decimal and hex addresses; the versioned save; ownership scoping; and that the schedule and coverage invariants hold by construction.

## 28. How the work was done: straight to main first, pull requests after the first deployment

The base application was built directly on `main`, ticket by ticket, with CI running on every push. That was quick for one author with nobody to review, and it cost something once: a `.gitignore` rule that excluded `src/coverage/` reached `main` before CI flagged it, and because the host deploys from `main`, a broken `main` is a broken app. Once the app was deployed, every change went through a feature branch and a pull request, merged only with CI green and after an automated reviewer's comments had each been fixed or answered, so production was never disturbed by work in progress. Changes that alter what the pipeline produces were also scored with the live selfcheck before merging. The pull requests, reviews and replies are in the repository's history. The review found real faults in almost every one; the ones that mattered are named in the entries below.

## 29. A trace of every run, kept in the application

When a kit came out poor there was no way to see why. Every model call now reports the step, provider, attempt, whether it was a first answer or a repair, the outcome, time queued in the rate limiter, latency and the provider's own token counts; every fetch reports its address, outcome, duration and size; steps are timed. `buildKit` wraps the shared client and fetcher for the length of one run and hands over a `RunTrace`, on success and on failure. It is stored with the job and the kit, served by `GET /api/kits/:id/trace`, shown in the interface, and written per case by `npm run evaluate -- --trace <file>`. It holds no prompt, answer or page text, addresses lose their credentials, query and fragment, and error text has anything credential-shaped removed, so it is safe to store and to show. A hosted tracing service was not used because a clean clone has no account with one. The rate limiter also stopped guessing: a call is reserved at an estimate and settled with what the provider counted. Server logs are JSON lines with a request id (returned as `X-Request-Id` and in every error body) and a job id on every job line; secrets are censored at any depth.

Review found that an observer that threw turned a good answer into a retried "network" failure, that totals were computed from a capped list, and that two batch workers could share one temporary output file. All fixed.

## 30. Hiring stages must quote the page, like requirements quote the posting

A stage used to be kept if half its words appeared anywhere on the hiring page. Common words could pass a stage the page never states, and a faithful paraphrase could be dropped. Now the model gives, for each stage and each interview insight, the words that state it, and code checks three things in order: the quote is in the source verbatim; if the claim is the source's own wording that is enough; otherwise the claim and its quote are compared by meaning. An insight is checked against the one comment its quote comes from, never against all of them joined, because a quote that only exists across the seam between two people's comments was said by nobody (review caught that). `kit.research_evidence` records the sentence each one rests on, the interface shows it, and rejected claims go to the run trace with the reason.

## 31. Embeddings where the question is about meaning, measured rather than assumed

Two checks are about meaning: whether two questions ask the same thing, and whether a quote supports a claim. Both use Gemini embeddings, whose free quota is separate from generation. They are an aid and never a dependency: offline, with no key, when the minute's budget is spent (it never waits) or on any failure, a lexical hashed n-gram embedder stands in, and callers are told which kind they got because the two are not on the same scale.

Thresholds come from `npm run calibrate` over `fixtures/similarity.json`, whose negatives are deliberately hard. The measurement changed the design twice. Embeddings alone could not tell a paraphrase from a different question on the same subject (a memory leak in Node.js and one on the JVM both scored about 0.90), so a plain rule sits beside the score: two questions that each name a technology the other does not are different questions. With it, 0.90 made no mistake on the set and found 12 of 14 paraphrases. And sentences written to share a claim's words scored as high as real support, which is why the quote must be verbatim and cited per claim, with similarity as the third line of defence rather than the first. A reviewer suggested the model's documented task prefix; measured, it made separation worse for this job (the closest pair of different questions rose above the lowest paraphrase), so plain text is sent and `thresholds.ts` records both measurements.

Duplicates are merged before the coverage check, and the kept question inherits the removed ones' requirements, so a merge cannot uncover anything. Never across categories. A regeneration drops drafts that repeat a question the user is keeping.

## 32. A model picks links only when keyword ranking has failed

Link ranking reads English hiring words, so "Inside Nimbus" or "Arbeiten bei uns" never earned a fetch. When the crawl ends without a hiring page, and only then, one model call sees the link texts and paths that were passed over and may name up to three. They are fetched and put to the same test as every other page: the page's own text decides. It costs nothing on the normal path, runs inside what is left of the crawl's deadline, and only addresses the crawl itself saw are fetched.

## 33. An LLM judge for what has no right answer, checked before it is believed

Everything with a right answer is checked by code. Whether a question is any good has none, so `npm run judge` scores a finished output against a written rubric with anchored 1-5 scales (relevance, specificity, difficulty fit and outline for questions; correctness and clarity for flashcards), reason before score. It is an offline tool and never part of the pipeline: no kit content is accepted or rejected on a model's opinion. The judge is the other provider whenever there is a key for it, so a model does not mark its own work. Deliberately bad items are mixed in under opaque labels, and each is checked on the one dimension it was built to fail; a judge that lets one through is reported as unreliable and the run exits 2. The first live run showed why per-dimension matters: the judge rightly called a wrong flashcard clear, and averaging its scores blamed the judge for the check's own mistake.

Last run over the five fixture kits, judged by Groq's gpt-oss-120b: 4.5 of 5 overall, difficulty fit lowest at 3.9. That led to one prompt change (what each difficulty level means, and a request for a mix). Re-measured, difficulty fit moved to 4.0, which is inside the run-to-run noise, so no quality gain is claimed; what did change is the mix, from 4 warm-up questions in 54 to 11 in 57. The judge cannot check facts about a company, since it never sees the pages.

## 34. Priority by wording, measured; and the policy the numbers asked for

Must or nice was "the line's wording, then the heading, then the model", on the theory that the model could not be trusted with it. That had never been measured. `fixtures/priority-cases.json` holds 42 awkward phrasings the rule was tuned on and 20 written afterwards that are never tuned against, and `npm run measure:priority` runs the real extraction prompt over them. Three of the 62 are labelled "defer" (the posting gives no signal either way, so there is no right answer to score; an offline test checks the rule stays silent on them), which leaves 40 and 19 scored:

| Policy | Tuned on | Held out |
|---|---|---|
| line, then any heading, then model (the old policy) | 39/40 | 15/19 |
| model only | 38/40 | 18/19 |
| line, then an explicit heading, then model (adopted) | 39/40 | 18/19 |

Three of the old policy's four held-out mistakes had one cause: a heading like "Requirements" is a container, postings put "is appreciated" and "not a dealbreaker" under it, and it was overruling a model that had read the line correctly. Headings that make a claim ("Nice to have", "Required qualifications") still win; container headings defer to the model. An offline test asserts the property that matters: on both sets the rule never overrules the model wrongly. The one remaining held-out miss is the model's own and is left alone, because fixing it would mean tuning on the held-out set. A case the model does not extract counts against every policy, so the scores are not flattered by dropping hard cases (review caught the first version doing that).

## 35. The jobs collection is the queue

Jobs lived in one process, and a restart marked whatever was running as interrupted. On a host that redeploys on every merge, that is a failure the user sees for something that was not their doing. Now a job is claimed with one atomic update that sets a lease; the lease is renewed while the job runs; a process that dies stops renewing, and once the lease lapses another process runs the job again, twice at most. A process told to stop hands its jobs back at once with the attempt refunded. A process that finds its lease taken stops and stores nothing, and a kit stored by a run that lost the job in that very instant is removed, so a job does not leave two kits behind. That is cleanup rather than a constraint: a process that died between storing the kit and removing it would leave one extra kit, which the user can delete. Kits are not keyed by job, because a user may deliberately generate a second kit for the same posting. No new service: MongoDB was already there. A run that has been given up on now also stops at its next step instead of fetching every page and assembling a kit nobody is waiting for.

Review caught the deployment case: a job mid-run when this version was deployed had no lease to lapse, and would have sat in "running" for ever, holding a slot and blocking resubmission. `start()` puts such jobs back in the queue.

## 36. Reading what a client-rendered page ships, without a browser

A headless browser is still ruled out (decision 14). But most pages that render in the browser carry their content in the HTML anyway. When a page's visible text is thin, its text is read from noscript fallbacks, hydration state (`__NEXT_DATA__` and other `application/json` scripts), JSON-LD, then the description. Only words a person would read are kept, while short list items survive, because on a hiring page the stages are exactly the short lines. Rich text stored as HTML goes through the same cleaning as a page, a lone comment included, so instructions hidden inside it are stripped. It is never mixed into a page that has real text, and the research log says when a page was read this way. This reduces the limitation rather than removing it: a page that fetches its content after loading still yields nothing, and says so.

## 37. Free, first-party checks in CI

CodeQL with the extended security queries runs on every pull request and weekly. Dependabot opens grouped weekly updates for npm and for the workflows. CI fails on a high-severity vulnerability in what is deployed, and on coverage falling below a floor set just under where it was first measured (91% of statements, 82% of branches, entry points excluded). The floor exists so coverage can only be lowered on purpose; it is not a target.
