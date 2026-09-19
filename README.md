# AI Interview Prep Kit - backend

[![CI](https://github.com/itsskofficial/trao-interview-prep-kit-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/itsskofficial/trao-interview-prep-kit-backend/actions/workflows/ci.yml)

Turns a job description, a company website and a number of days into a structured interview preparation kit: a company brief, a role breakdown, a categorised question bank, flashcards and a day-by-day schedule. This repository holds the research and generation pipeline, the HTTP API and the batch command. The interface is in [trao-interview-prep-kit-frontend](https://github.com/itsskofficial/trao-interview-prep-kit-frontend).

- **Live app:** https://trao-interview-prep-kit.vercel.app
- **Live API:** https://trao-interview-prep-kit-backend.onrender.com (`/api/health`)
- **Why each decision was made:** [DECISIONS.md](DECISIONS.md), 27 short entries. This README summarises them.

## Contents

1. [Batch entry point](#1-batch-entry-point)
2. [Stack, provider and model](#2-stack-provider-and-model)
3. [Setup](#3-setup)
4. [Architecture](#4-architecture)
5. [Retrieval approach and sources](#5-retrieval-approach-and-sources)
6. [How research and generation are sequenced](#6-how-research-and-generation-are-sequenced)
7. [The second pass](#7-the-second-pass)
8. [How the schedule is allocated](#8-how-the-schedule-is-allocated)
9. [Generated, edited and pinned state](#9-generated-edited-and-pinned-state)
10. [Edge cases and failure handling](#10-edge-cases-and-failure-handling)
11. [Security](#11-security)
12. [Creative feature](#12-creative-feature-weak-spots-then-re-plan)
13. [Testing](#13-testing)
14. [Trade-offs and known limitations](#14-trade-offs-and-known-limitations)

## 1. Batch entry point

Requires Node.js 20.18.1 or newer (22 recommended). From a clean clone:

```bash
npm install
cp .env.example .env          # then set GEMINI_API_KEY (free key: https://aistudio.google.com)
npm run evaluate -- --input <cases.json> --output <kits.json>
```

- Reads an array of `{ id, jd, company_url, days }` and writes the Appendix B file: one entry per case, `ok` with a kit or `failed` with `{ code, message }`.
- Runs the same `buildKit` function the application uses. There is no second implementation.
- One bad or failing case never aborts the run. Entries are validated one by one, so a malformed case fails alone.
- Company sites on a local address work, on any port and under any path; relative links are resolved against the page they were found on.
- Five cases take about 2 minutes 20 seconds on the free tier (measured; the ceiling is the provider's requests per minute, see [decision 19](DECISIONS.md)). Each case also has a 170-second budget and is recorded as `TIMEOUT` if it overruns, so one hung site cannot cost the fifteen minutes; a case that is given up on stops making model calls, so it cannot starve the cases after it. The crawl has its own 45-second deadline and counts failed fetches against its page budget.
- `GROQ_API_KEY` is optional. When set, Groq takes over if Gemini's daily quota runs out. `LLM_PROVIDER=groq` makes Groq the primary and the command works, but be aware of what its free tier allows: 8K tokens a minute means a kit takes several minutes there (each case gets ten minutes instead of 170 seconds), so **five cases inside fifteen minutes needs the Gemini key**.
- The cases file may start with a byte-order mark, ids may be numbers, `days` may be a numeric string, and a company address may be typed without `http://`. The output file is rewritten after every case, so a run stopped early still leaves what it finished.

Try it against the bundled fixture companies:

```bash
npm run fixtures              # serves five company sites on http://localhost:8099
npm run evaluate -- --input fixtures/cases.json --output kits.json
npm run selfcheck             # same run, scored against the brief's automated rubric
```

`failed` is reserved for a case with no kit at all: an empty description (`JD_EMPTY`), a malformed case (`INVALID_INPUT`), no model available on any provider (`LLM_UNAVAILABLE`), or a timeout. A company site that is unreachable, 404 or has no hiring page is **`ok`**, with the gap recorded in the kit. The Appendix B example shows `COMPANY_UNREACHABLE` as failed, but the FAQ says to reserve `failed` for "a case you could not produce a kit for at all" and the scoring rewards unreachable sites being "recorded rather than fatal"; a job description alone is enough for requirements, questions, flashcards and a schedule ([decision 1](DECISIONS.md)).

## 2. Stack, provider and model

The preferred stack, unchanged: **Node.js + Express 5, MongoDB, TypeScript**, with Zod for every schema and Vitest for tests. It runs through `tsx`, so there is no build step between `npm install` and `npm run evaluate`.

**LLM: Google Gemini, model `gemini-3.5-flash-lite`, free tier.** Measured on a free key: every full Flash model allows 20 requests a day, which is two kits. Flash-Lite allows 15 requests/min, 250K tokens/min and 500 requests/day. **Fallback: Groq `openai/gpt-oss-120b`**, whose free tier allows only 8K tokens/min, too slow as a primary for five cases in fifteen minutes but fine as a safety net.

Free tiers limit tokens per minute as well as requests, so the client counts both **before** sending (a sliding one-minute window, defaults set under the measured limits). When a 429 still arrives, the provider's `Retry-After` wins over our own jittered backoff. A per-minute limit means wait; an exhausted per-day quota means fail over, because waiting a minute will not help, and the two are told apart from the error body. Invalid JSON or a schema failure gets one repair attempt in which the model is shown the exact validation errors; a second failure costs that section, not the kit.

## 3. Setup

### Local, nothing to configure

```bash
npm install
npm run dev:offline
```

Starts the API on port 4000 with an in-memory MongoDB, the fixture company sites on port 8099, and `LLM_PROVIDER=offline`, a clearly labelled mechanical stand-in for the model (requirements are the posting's bullet lines, questions are templated). Everything downstream of the model is the real code. It exists so the whole application, and the interface's end-to-end tests, run with no key and no quota. It is refused when `NODE_ENV=production`.

### Local, with a real model and database

```bash
cp .env.example .env          # set GEMINI_API_KEY, MONGODB_URI, JWT_SECRET
npm run dev
```

Every environment variable is documented in [.env.example](.env.example).

### Deployed

[render.yaml](render.yaml) is a Render blueprint: New > Blueprint > this repository. Render asks for `MONGODB_URI` (MongoDB Atlas free tier), `GEMINI_API_KEY` and `GROQ_API_KEY`, and generates `JWT_SECRET`. In production the server refuses to start with a missing or short `JWT_SECRET`, sets `Secure` cookies and refuses private addresses. Secrets live only in the host's environment; `.env` is git-ignored. A scheduled workflow requests `/api/health` every ten minutes so the free instance does not sleep.

## 4. Architecture

```
src/
  kit/          the kit schema (Zod, Appendix A names exactly) and structure validation
  batch/        Appendix B shapes and the batch runner
  cli/          npm run evaluate
  llm/          provider-agnostic client: limiter, retry, failover, JSON repair; Gemini, Groq, offline
  extraction/   requirements from the posting, verified against it
  retrieval/    URL guard, fetcher, HTML cleaning, link ranking, crawl, public discussion
  generation/   company brief, the plan of question calls, questions, flashcards
  coverage/     uncovered requirements, the gap-closing loop, the fallback question
  scheduling/   deterministic allocation across days
  pipeline/     buildKit: the one path from a description to a kit
  builder/      every user change as a pure function; the regeneration merge; the regenerator
  practice/     Leitner boxes, session ordering, weak spots
  jobs/         in-process job runner
  persistence/  MongoDB collections and the kit repository
  api/          Express routes, auth, error shape
```

Retrieval, extraction, generation, scheduling and persistence do not import each other; `pipeline/` is the only module that knows the order. The API and the batch command both call `buildKit`. The kit schema is defined once and validates model output, the assembled kit before it is saved or written, and the batch files. Extensions to Appendix A are additive and optional (`origin`, `edited`, `pinned`, `evidence`, `hiring_stages`, `interview_insights`, `research_log`, `notes`, `schedule.replan`), so a bare Appendix A kit still validates.

**Generation is a job, not a request.** Starting a kit returns `202` with a job at once; an in-process runner executes two at a time and writes each step to the job document, which the interface polls. Polling was chosen over server-sent events because it survives free-tier proxies, sleeping instances and a closed laptop lid. The same posting submitted twice returns the running job (enforced by a partial unique index, so two racing requests cannot both insert) or offers the existing kit. A failed job stores `{ code, message }` and can be retried. Jobs left running by a restart are marked interrupted and retryable on boot ([decision 21](DECISIONS.md)).

## 5. Retrieval approach and sources

**Sources used:** the company's own site (the URL given, and same-origin pages found by crawling it, plus `sitemap.xml` beside it when present); **Hacker News** through the Algolia search API; **Stack Exchange Workplace** through the Stack Exchange API. Both APIs are official, keyless and open to programmatic use. **Reddit and Glassdoor were left out**: most interview discussion lives there, but their robots.txt and terms forbid unauthenticated automated access.

**Finding the hiring page.** No path is assumed. When the company's address is a folder on a shared origin (`http://host/acme/`), its site is that folder and nothing beside it, so another company's hiring page on the same host cannot be picked up. Every in-scope link is scored in code from its anchor text (what the company chose to call the page), the words in its path, where it sits (navigation and footers get a point) and its depth. Interviewing and hiring words score highest, careers and jobs next, then handbook, people, culture and engineering pages, which are rarely the answer but often one click from it. The crawler always fetches the best-scoring unvisited link next, to depth two, within twelve pages. A link called "Careers" proves nothing, so a page counts as the hiring page only if **its own text** describes a process: at least three process terms, matched as whole words, and one unambiguous anchor such as "interview". "Round" and "stage" only count beside an ordinal, and "offer" only in "make an offer", because a careers page that says "we offer competitive pay to engineers around the world" has not described a process. Links found on such a page inherit part of its score, which is how a vaguely named "What to expect" page two clicks down gets fetched.

**robots.txt and politeness.** robots.txt is read once per origin and obeyed; requests to one host are serialised one second apart; 429, 5xx, timeouts and network errors retry twice with backoff honouring `Retry-After`. A source that cannot be retrieved is skipped and recorded with its reason in the kit's `research_log`; it never fails the run.

If the company URL itself fails there is no fallback to the origin root: when several companies are served under one origin, as evaluation fixtures may be, the root is a different site, and a brief about the wrong company is worse than an honest "could not be read".

## 6. How research and generation are sequenced

Each step uses what the previous ones actually found. Steps marked **code** involve no model.

| # | Step | Responsible for |
|---|------|-----------------|
| 1 | **Extract** | Title, seniority, location, responsibilities and requirements from the pasted posting. No retrieval. The model returns each requirement with a verbatim `evidence` quote; **code** drops any requirement whose quote is not in the posting, replaces a restatement that drifted from its evidence with the posting's own words, decides `must` or `nice` from the wording (the evidence, then its sentence, then the heading above it), and assigns ids in posting order. |
| 2 | **Crawl** (code) | Homepage, ranked links, the hiring page if one exists. |
| 3 | **Public discussion** | Needs a company name, which often only becomes known from the crawl, so it runs after it. A hit is kept only if it names the company and talks about interviewing. |
| 4 | **Brief** | One call over the cleaned pages and discussion: summary, what they do, hiring stages, interview insights. Code keeps a stage or insight only if it is traceable to the text it claims to come from. With nothing retrieved the model is **not asked**: code writes a brief that says so. |
| 5 | **Plan the question calls** (code) | A pure function from (requirements, seniority, published stages, brief) to a list of calls. |
| 6 | **Questions** | One call per planned category, each with its own instructions and only its own requirements. |
| 7 | **Coverage loop** | Code finds the gaps; the model is asked for those only; code checks again. |
| 8 | **Flashcards** | One call, tied to requirement ids. |
| 9 | **Schedule** (code) | Arithmetic. |
| 10 | **Validate** (code) | Nothing leaves without passing the structure check. |

The sequencing is genuine, and decided by code rather than a prompt:

- **Technical** questions get technical and domain requirements; **behavioural** questions get behavioural ones. They never share a call or instructions.
- A **published take-home** adds "make one question a take-home style task" to the technical call; pair programming adds a live scenario; a values or hiring-manager round adds probing follow-ups to the behavioural call.
- **System design** is only asked for if the company publishes a design round, the posting asks for design experience, or the role is senior.
- **Company fit** is only asked for if something about the company was actually retrieved. A dead URL means no company-fit call at all.

A typical kit costs seven model calls. After extraction no step can fail the kit: a failed section leaves a note, and coverage is guaranteed by code either way.

## 7. The second pass

Coverage is set arithmetic in code: a requirement is covered if some question lists its id. After the first draft, code finds the gaps and asks the model for questions covering **those requirements only**, by category, then checks again. `coverage.passes` counts checks: a clean first draft is 1, one gap-closing round is 2.

The loop stops on the first of: no must-have uncovered; a pass that closed nothing (asking the same model the same thing again spends quota for the same answer); three checks. Three is enough because a targeted "write one question for each of these" closes gaps in one round, and the free tier budget is about ten calls a kit. Nice-to-have gaps get one attempt and are then reported in `uncovered_requirement_ids` rather than forced.

If a must-have is still uncovered after that, **code writes a plain question from the requirement text**, marked `origin: "fallback"`, and the kit says so. A kit that ships with an uncovered must-have "has failed at the one job it had", so that guarantee does not depend on a model. If every question call failed, every must-have would still be covered.

## 8. How the schedule is allocated

No model. Questions are ranked must-have first, then hardest first, then original order, and that ranking is cut into contiguous slices across **exactly** the requested days, leftovers going to the earliest days. The hardest must-have material is therefore day 1, and the last day is the easiest nice-to-have material. Every question is scheduled, so every covered must-have appears. Minutes are 10, 15 or 20 per question by difficulty with a 30-minute floor per day, so they are always integers.

- **1 day:** everything in that day, in priority order.
- **60 days, 25 questions:** the first 25 days learn one question each; the rest are revision days that walk the same ranking again at half the time per question, rather than sitting empty or spreading thin to the end.
- **No questions:** every day still exists and says so.

After any edit the schedule is recomputed by the same function, so it can never reference a deleted question.

## 9. Generated, edited and pinned state

Every question, flashcard and the brief carry three optional fields: `origin` (`generated`, `user`, or `fallback` for a question written by code), `edited` (set the moment the user changes the content, never cleared) and `pinned` (the user saying "keep this"; moving a question to another category pins it). An item is **protected** if it is user-written, edited or pinned. That one predicate is the whole rule: regeneration never removes, rewrites or reorders a protected item.

- **Changes are operations, not documents.** The interface never sends the kit back. Each change is one small request naming one thing, implemented as a pure function from kit to kit. Ids come from counters that only go up, so an id is never reused, even after a delete or an undone regeneration.
- **One way to save.** `kits.mutate` loads the kit, applies the pure change, validates the result, and saves only if the stored `version` is still the one it read; otherwise it re-runs the change on the newer kit. Five edits fired at the same instant all land, and there is a test for exactly that.
- **A regeneration merges into the kit as it is when the model answers, not as it was when it was asked.** `POST /regenerate` returns `202`; the model call runs in the background, told which questions the user is keeping so it writes different ones; its result goes through the same `mutate`. A question the user started typing in ten seconds ago is already `edited`, therefore protected, therefore kept. Tests hold the model back, edit in the same category and elsewhere, then release it. Other categories are not read or rewritten (a test compares them byte for byte). If the swap left a must-have uncovered, code adds a fallback question.
- **The brief** is one item, so a brief the user edited is not silently replaced: the API answers `BRIEF_PROTECTED` and the interface asks first. If the user edits it while a new one is being written, their text wins.
- **Undo.** The latest regeneration stores what it removed and added; one action restores the old questions with their original ids and removes the new ones, except any the user has since made their own.

Not done: per-field tracking. Editing a prompt protects the whole question, including its outline. It would let an outline refresh under an edited prompt, at the cost of a merge that is much harder to explain and to trust.

## 10. Edge cases and failure handling

| Case | What happens |
|------|--------------|
| Company URL invalid, 404, times out | `ok`. Kit built from the posting alone; the brief says the site could not be read and why; `pages_used` is empty; the attempt is in `research_log`; no company-fit questions are generated. |
| No discoverable hiring or about page | `ok`. `hiring_stages` is forced empty whatever the model says; the log records that no process page was found among the pages read; a note says the questions are not tailored to a known format. |
| Two-line stub | A thin kit that says it is thin. Requirements without a verifiable quote are dropped, never padded. With zero requirements the kit has zero requirement questions and a valid, honest schedule. |
| Public discussion finds nothing | Each source is logged `empty`. Results that matched the name but were about something else are not cited: a live run found three Hacker News hits for a fixture company called Hooli, all about a television show, and used none. |
| Model returns invalid JSON or an incomplete kit | Lenient parse, schema validation, one repair attempt with the exact errors, then that section degrades with a note. The assembled kit is validated before it is returned or saved. |
| Provider rate-limits or briefly fails | Counted before sending; `Retry-After` honoured; jittered backoff; per-day exhaustion fails over to the second provider. |
| Same description and company twice | In the batch: researched once, both entries get the result. In the app: the running job is returned, or the existing kit is offered, enforced by a unique index. |
| 1-day or 60-day schedule | See section 8. Both are in the test suite and the fixture cases. |
| Generation takes 90 seconds, fails halfway, is triggered twice | See "Generation is a job" in section 4. |

## 11. Security

- **URLs.** Only http and https, no embedded credentials. Private, loopback and link-local addresses are refused when `NODE_ENV=production`. The check that matters runs in the socket's DNS lookup, against the address actually being connected to, which closes DNS rebinding and covers every redirect hop. Outside production they are allowed, because evaluation sites may be served from localhost; `ALLOW_PRIVATE_URLS` forces either behaviour.
- **Content.** HTML, XHTML, plain text and XML only; a page is read up to 3 MB and used as far as it got (the limit is enforced while streaming, because `Content-Length` can lie, and modern marketing pages are often megabytes of markup with the readable text near the top); ten-second timeout; at most five redirects, each re-validated.
- **Fetched text is content, never instructions.** Scripts, comments and anything hidden by attribute or style are removed before text is taken, since that is where text aimed at a model gets planted. The posting and every page reach the model only inside labelled `<untrusted_*>` blocks that content cannot close, under a system rule that such text is never an instruction. The structural defence does not rely on the model obeying: nothing a page says can add a requirement (requirements come only from verified quotes of the posting), change the output shape (every answer is schema-validated) or add a hiring stage (stages must be traceable to the hiring page). The `umbrella` fixture plants instructions in a comment, a hidden element and visible text, and the posting for that case carries "ignore all previous instructions"; the self-check asserts none of it reaches the kit.
- **Auth.** bcrypt (cost 12); a seven-day HS256 JWT in an `httpOnly`, `SameSite=Lax` cookie, `Secure` in production; the verifier accepts HS256 only; sign-in answers identically, in the same time, for a wrong password and an unknown email; auth routes are rate limited. Kits are reached only through a repository whose every method takes the owner's id, and someone else's kit answers 404, so ids cannot be probed.

## 12. Creative feature: weak spots, then re-plan

Practice uses Leitner boxes: confidence 1 "no idea" sends a card back to box 1, 2 "shaky" down one, 3 "mostly" up one, 4 "confident" up two. The next session is cards never seen, then the lowest box, then the card seen longest ago. SM-2 style intervals were rejected on purpose: they schedule reviews days and weeks out, and someone with an interview in five days needs "what am I worst at right now". A plain confidence sort was rejected because it forgets history: one lucky answer would hide a card that failed three times.

The feature built on it solves the real problem two days before an interview: **the plan made on day one no longer matches what you turned out not to know.** Practice results are mapped back through `requirement_ids` to the posting's requirements, must-haves first, each with the questions that cover it. One action then re-plans the schedule from a chosen day: days already done are kept, and everything is dealt out again over the remaining days with the weak-spot questions first. It reuses the same deterministic allocator, so the schedule still spans exactly the requested days and still schedules every question. The re-plan is stored in the kit, so later edits keep it; regenerating the schedule returns to the default plan.

Two smaller additions: **undo for a regeneration**, because losing a generated question you liked is the obvious fear; and a **printable one-page summary** in the interface.

## 13. Testing

```bash
npm test                # 329 tests, no network, no live model
npm run typecheck
npm run selfcheck       # live model, scored against the published rubric (about 40 requests)
```

- The behaviour the brief names is tested as pure functions: **schedule allocation** (exact day count for 1, 5, 12, 13 and 60 days; integer minutes; every question and every must-have scheduled; must-have and harder material first; revision days; zero questions; determinism), **coverage checking** (the loop, its stop rules, the fallback, "never leaves a must-have uncovered, whatever the model does") and **structure validation** (every Appendix A rule, including cross-references, reported all at once).
- The **pipeline** is tested through its one entry point, with a model stub that answers by step rather than by call order and the fixture company sites served over real HTTP.
- The **API** is tested over HTTP against an in-memory MongoDB: ownership isolation, deduplication under a race, per-item operations, concurrent edits, an edit racing a regeneration, undo.
- `npm run selfcheck` runs the five fixture cases live and scores them against the brief's automated rubric, with the expected must-haves recorded per case so extraction is measured, not eyeballed. Last run: every extraction, research and robustness check passed.
- The interface's browser tests live in the frontend repository and run against this backend's offline mode.

## 14. Trade-offs and known limitations

- **No JavaScript rendering.** Pages that render only in a browser yield little text, and are logged as such. A hosted scraper was ruled out: it cannot reach a site served from the evaluator's localhost, and it would need a third API key.
- **Jobs and regenerations live in one process.** A restart marks them interrupted and retryable. An external queue is the first thing to add with a second instance.
- **Priority by wording is heuristic.** The phrase lists are in one file and tested, and the model's label is the last resort, but an unusual posting can still be read wrongly.
- **Discussion search is name-based**, so a company with a common name mostly yields results that are filtered out. That is reported, not hidden.
- **The free hosting tier sleeps.** A scheduled request keeps it awake, and the interface says "waking the server" if a request is slow.
- **Not built, on purpose:** email verification, password reset, roles, anything in the brief's out-of-scope list.
