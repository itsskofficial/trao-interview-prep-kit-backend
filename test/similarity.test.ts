import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { groupDuplicates, nameDifferentThings, namedTerms, sameQuestion } from "../src/similarity/duplicates";
import { geminiEmbedder, lexicalEmbedder, similarity, withFallback, type Embedder } from "../src/similarity/embedder";
import { mergeDuplicateQuestions, withoutDuplicates } from "../src/similarity/questions";
import { checkSupport } from "../src/similarity/support";
import { DUPLICATE_THRESHOLD, SUPPORT_THRESHOLD } from "../src/similarity/thresholds";

/**
 * A stand-in for a semantic model: texts that mention the same topic word get the same vector,
 * everything else is orthogonal. Similarity is then 1 or 0, so a test states meaning outright.
 */
function topicEmbedder(topics: string[]): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async embed(texts) {
      calls.push(texts);
      const axes = new Map<string, number>();
      const axisOf = (text: string) => {
        const key = topics.find((topic) => text.toLowerCase().includes(topic)) ?? `unique:${text}`;
        if (!axes.has(key)) axes.set(key, axes.size);
        return axes.get(key)!;
      };
      const indices = texts.map(axisOf);
      return { kind: "semantic", source: "topic-fake", vectors: indices.map((axis) => Array.from({ length: texts.length + topics.length }, (_, i) => (i === axis ? 1 : 0))) };
    },
  };
}

describe("lexical embedder", () => {
  it("scores a near-verbatim repeat above the duplicate threshold and a different question far below it", async () => {
    const { vectors, kind } = await lexicalEmbedder().embed([
      "How would you debug a memory leak in a Node.js service?",
      "How would you debug a memory leak in a Node.js service in production?",
      "Tell me about a time you mentored a junior engineer.",
    ]);
    expect(kind).toBe("lexical");
    expect(similarity(vectors[0]!, vectors[1]!)).toBeGreaterThan(DUPLICATE_THRESHOLD.lexical);
    expect(similarity(vectors[0]!, vectors[2]!)).toBeLessThan(0.2);
  });

  it("is deterministic, unit length, and copes with empty text", async () => {
    const embedder = lexicalEmbedder();
    const [first, second] = await Promise.all([embedder.embed(["PostgreSQL indexes", ""]), embedder.embed(["PostgreSQL indexes", ""])]);
    expect(first.vectors).toEqual(second.vectors);
    expect(similarity(first.vectors[0]!, first.vectors[0]!)).toBeCloseTo(1, 6);
    expect(first.vectors[1]!.every((value) => value === 0)).toBe(true);
  });

  it("treats word forms as one word", async () => {
    const { vectors } = await lexicalEmbedder().embed(["mentoring junior engineers", "mentored a junior engineer"]);
    expect(similarity(vectors[0]!, vectors[1]!)).toBeGreaterThan(0.6);
  });
});

describe("Gemini embedder", () => {
  const ok = (count: number) => new Response(JSON.stringify({ embeddings: Array.from({ length: count }, () => ({ values: [3, 4] })) }), { status: 200 });

  it("sends texts in batches of 100, marks each for similarity, and returns unit vectors", async () => {
    const bodies: Array<{ requests: Array<{ model: string; taskType: string; content: { parts: Array<{ text: string }> } }> }> = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      bodies.push(body);
      return ok(body.requests.length);
    }) as typeof fetch;
    const embedder = geminiEmbedder({ apiKey: "k", model: "gemini-embedding-2", textsPerMinute: 1_000, fetchFn });
    const result = await embedder.embed(Array.from({ length: 130 }, (_, i) => `text ${i}`));

    expect(bodies.map((body) => body.requests.length)).toEqual([100, 30]);
    expect(bodies[0]!.requests[0]).toMatchObject({ model: "models/gemini-embedding-2", taskType: "SEMANTIC_SIMILARITY", content: { parts: [{ text: "text 0" }] } });
    expect(result).toMatchObject({ kind: "semantic", source: "gemini:gemini-embedding-2" });
    expect(result.vectors).toHaveLength(130);
    expect(result.vectors[0]).toEqual([0.6, 0.8]);
  });

  it("sends the key in a header, never in the address", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      seen = { url: String(url), headers: init!.headers as Record<string, string> };
      return ok(1);
    }) as typeof fetch;
    await geminiEmbedder({ apiKey: "secret-key", model: "m", textsPerMinute: 10, fetchFn }).embed(["a"]);
    expect(seen!.url).not.toContain("secret-key");
    expect(seen!.headers["x-goog-api-key"]).toBe("secret-key");
  });

  it("refuses at once when this minute's budget is spent, and recovers when the minute passes", async () => {
    let now = 0;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => ok(JSON.parse(String(init!.body)).requests.length)) as typeof fetch;
    const embedder = geminiEmbedder({ apiKey: "k", model: "m", textsPerMinute: 5, fetchFn, now: () => now });
    await embedder.embed(["a", "b", "c"]);
    await expect(embedder.embed(["d", "e", "f"])).rejects.toThrow(/budget/);
    now = 61_000;
    await expect(embedder.embed(["d", "e", "f"])).resolves.toMatchObject({ kind: "semantic" });
  });

  it("fails on an error status, a wrong count, or a missing key", async () => {
    const status = (async () => new Response("{}", { status: 429 })) as typeof fetch;
    const short = (async () => ok(1)) as typeof fetch;
    await expect(geminiEmbedder({ apiKey: "k", model: "m", textsPerMinute: 10, fetchFn: status }).embed(["a"])).rejects.toThrow("429");
    await expect(geminiEmbedder({ apiKey: "k", model: "m", textsPerMinute: 10, fetchFn: short }).embed(["a", "b"])).rejects.toThrow(/wrong number/);
    await expect(geminiEmbedder({ apiKey: "", model: "m", textsPerMinute: 10 }).embed(["a"])).rejects.toThrow(/GEMINI_API_KEY/);
  });
});

describe("fallback", () => {
  const broken: Embedder = { embed: async () => { throw new Error("Gemini embeddings 503"); } };

  it("answers lexically when the semantic call fails, and says why", async () => {
    const reasons: string[] = [];
    const result = await withFallback(broken, lexicalEmbedder(), (reason) => reasons.push(reason)).embed(["a question"]);
    expect(result.kind).toBe("lexical");
    expect(reasons).toEqual(["Gemini embeddings 503"]);
  });

  it("does not mistake the caller giving up for a failure", async () => {
    const abandoned = new AbortController();
    abandoned.abort();
    await expect(withFallback(broken, lexicalEmbedder()).embed(["a"], abandoned.signal)).rejects.toThrow();
  });
});

describe("named terms", () => {
  it("recognises technologies by their shape, not from a list", () => {
    expect([...namedTerms("How would you debug a memory leak in a Node.js service running on AWS with useMemo and C++?")].sort()).toEqual(["aws", "c++", "node.js", "usememo"].sort());
  });

  it("does not count the word that opens a sentence, or the word I", () => {
    expect([...namedTerms("Describe a time. Tell me what I did. Walk me through it.")]).toEqual([]);
  });

  it("knows the common other names of a thing", () => {
    expect(nameDifferentThings("Explain indexes in PostgreSQL.", "When does an index in Postgres hurt?")).toBe(false);
    expect(nameDifferentThings("How does the scheduler work in K8s?", "How does Kubernetes schedule a pod?")).toBe(false);
  });

  it("tells two questions apart when each names something the other does not", () => {
    expect(nameDifferentThings("How would you debug a memory leak in a Node.js service?", "How would you debug a memory leak in a Java service on the JVM?")).toBe(true);
    expect(nameDifferentThings("What is the difference between useMemo and useCallback in React?", "What is the difference between useEffect and useLayoutEffect in React?")).toBe(true);
    // One side naming more than the other is a more specific wording of the same question, not a different one.
    expect(nameDifferentThings("Design a URL shortener.", "How would you design a link shortening service?")).toBe(false);
  });

  it("is what stops a high score from merging different questions", () => {
    expect(sameQuestion("semantic", 0.95, "Walk me through your experience with Python.", "Walk me through your experience with PostgreSQL.")).toBe(false);
    expect(sameQuestion("semantic", 0.95, "Why this company?", "What draws you to this company?")).toBe(true);
    expect(sameQuestion("semantic", DUPLICATE_THRESHOLD.semantic - 0.01, "Why this company?", "What draws you to this company?")).toBe(false);
  });
});

describe("grouping duplicates", () => {
  it("keeps the first of each group and embeds everything in one call", async () => {
    const embedder = topicEmbedder(["leak", "mentor"]);
    const result = await groupDuplicates(["memory leak A", "mentor A", "memory leak B", "indexes", "mentor B"], (text) => text, embedder);
    expect(result.groups).toEqual([
      { kept: "memory leak A", duplicates: ["memory leak B"] },
      { kept: "mentor A", duplicates: ["mentor B"] },
      { kept: "indexes", duplicates: [] },
    ]);
    expect(embedder.calls).toHaveLength(1);
  });

  it("makes no call for fewer than two items", async () => {
    const embedder = topicEmbedder([]);
    await groupDuplicates(["only one"], (text) => text, embedder);
    expect(embedder.calls).toEqual([]);
  });
});

describe("merging duplicate questions", () => {
  const question = (id: string, prompt: string, requirementIds: string[], category: "technical" | "behavioural" = "technical") => ({ id, prompt, requirement_ids: requirementIds, category });

  it("gives the kept question the requirements of the ones removed, so a merge never uncovers anything", async () => {
    const questions = [question("q1", "memory leak in a service", ["r1"]), question("q2", "indexes", ["r2"]), question("q3", "finding a memory leak", ["r3", "r1"])];
    const merged = await mergeDuplicateQuestions(questions, topicEmbedder(["leak"]));

    expect(merged.questions).toEqual([question("q1", "memory leak in a service", ["r1", "r3"]), question("q2", "indexes", ["r2"])]);
    expect(merged.removed).toEqual([{ id: "q3", into: "q1" }]);
    expect(merged.comparedWith).toBe("topic-fake");
  });

  it("never merges across categories: the same subject in two interviews is two questions", async () => {
    const questions = [question("q1", "conflict in code review", ["r1"]), question("q2", "a time you had conflict in review", ["r2"], "behavioural")];
    const merged = await mergeDuplicateQuestions(questions, topicEmbedder(["conflict"]));
    expect(merged.removed).toEqual([]);
    expect(merged.questions).toEqual(questions);
  });

  it("keeps the original order", async () => {
    const questions = [question("q1", "alpha", ["r1"]), question("q2", "beta leak", ["r2"]), question("q3", "gamma", ["r3"]), question("q4", "delta leak", ["r4"])];
    const merged = await mergeDuplicateQuestions(questions, topicEmbedder(["leak"]));
    expect(merged.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
  });
});

describe("dropping drafts that repeat what is being kept", () => {
  it("drops a draft that repeats a kept question or an earlier draft", async () => {
    const drafts = [{ prompt: "another memory leak question" }, { prompt: "caching strategy" }, { prompt: "caching strategy, reworded" }, { prompt: "sharding" }];
    const result = await withoutDuplicates(["the kept memory leak question"], drafts, topicEmbedder(["leak", "caching"]));
    expect(result.fresh.map((draft) => draft.prompt)).toEqual(["caching strategy", "sharding"]);
    expect(result.dropped).toBe(2);
  });
});

describe("claim support", () => {
  const page = "Our hiring process has four stages. Recruiter call (30 minutes). We then send a small project to complete in your own time. Our CEO started the company in 2014.";

  it("drops a claim whose quote is not in the source, without asking the embedder", async () => {
    const embedder = topicEmbedder([]);
    const result = await checkSupport([{ text: "Whiteboard puzzles", evidence: "You will solve whiteboard puzzles." }], page, embedder);
    expect(result).toEqual({ kept: [], dropped: [{ text: "Whiteboard puzzles", reason: "the quoted words are not in the source" }] });
    expect(embedder.calls).toEqual([]);
  });

  it("keeps a claim that is the source's own wording, without asking the embedder", async () => {
    const embedder = topicEmbedder([]);
    const result = await checkSupport([{ text: "Recruiter call", evidence: "Recruiter call (30 minutes)." }], page, embedder);
    expect(result.kept).toEqual([{ text: "Recruiter call", quote: "Recruiter call (30 minutes)." }]);
    expect(embedder.calls).toEqual([]);
  });

  it("compares meaning for a paraphrase: keeps one the quote supports, drops one pinned on an unrelated sentence", async () => {
    // The fake puts "take-home" and "small project" on the same axis, as a semantic model would.
    const embedder: Embedder = {
      embed: async (texts) => ({ kind: "semantic", source: "fake", vectors: texts.map((text) => (/take-home|small project/i.test(text) ? [1, 0, 0] : /ceo/i.test(text) ? [0, 1, 0] : [0, 0, 1])) }),
    };
    const result = await checkSupport(
      [
        { text: "Take-home exercise", evidence: "We then send a small project to complete in your own time." },
        { text: "System design round", evidence: "Our CEO started the company in 2014." },
      ],
      page,
      embedder,
    );
    expect(result.kept.map((claim) => claim.text)).toEqual(["Take-home exercise"]);
    expect(result.dropped).toEqual([{ text: "System design round", reason: "the quoted words do not say this" }]);
    expect(result.comparedWith).toBe("fake");
  });

  it("without semantic embeddings, asks for shared words, which is stricter", async () => {
    const result = await checkSupport(
      [
        { text: "Take-home exercise", evidence: "We then send a small project to complete in your own time." },
        { text: "A small take-home project", evidence: "We then send a small project to complete in your own time." },
      ],
      page,
      lexicalEmbedder(),
    );
    expect(result.kept.map((claim) => claim.text)).toEqual(["A small take-home project"]);
    expect(SUPPORT_THRESHOLD.lexicalOverlap).toBeGreaterThan(0);
  });

  it("keeps stages in the order the company publishes them, whichever way each was accepted", async () => {
    const embedder: Embedder = { embed: async (texts) => ({ kind: "semantic", source: "fake", vectors: texts.map(() => [1]) }) };
    const result = await checkSupport(
      [
        { text: "Project at home", evidence: "We then send a small project to complete in your own time." },
        { text: "Recruiter call", evidence: "Recruiter call (30 minutes)." },
      ],
      page,
      embedder,
    );
    expect(result.kept.map((claim) => claim.text)).toEqual(["Project at home", "Recruiter call"]);
  });

  it("keeps nothing when there is no source at all", async () => {
    const result = await checkSupport([{ text: "Anything", evidence: "Anything" }], "", lexicalEmbedder());
    expect(result.kept).toEqual([]);
  });
});

describe("the labelled set, with the embedder that needs no network", () => {
  const labelled = JSON.parse(readFileSync("fixtures/similarity.json", "utf8")) as {
    duplicates: Array<{ a: string; b: string; same: boolean }>;
    grounding: Array<{ claim: string; sentence: string; supported: boolean }>;
  };

  it("never calls two different questions the same", async () => {
    const { vectors, kind } = await lexicalEmbedder().embed(labelled.duplicates.flatMap((pair) => [pair.a, pair.b]));
    const wrong = labelled.duplicates.filter((pair, index) => !pair.same && sameQuestion(kind, similarity(vectors[index * 2]!, vectors[index * 2 + 1]!), pair.a, pair.b));
    expect(wrong).toEqual([]);
  });

  it("has hard negatives: every different pair shares a subject, and the named-terms rule alone does not decide the set", () => {
    const different = labelled.duplicates.filter((pair) => !pair.same);
    expect(different.length).toBeGreaterThanOrEqual(14);
    expect(different.some((pair) => !nameDifferentThings(pair.a, pair.b))).toBe(true);
    // The rule must never veto a real paraphrase more than rarely, or the semantic threshold would be doing nothing.
    const vetoedParaphrases = labelled.duplicates.filter((pair) => pair.same && nameDifferentThings(pair.a, pair.b));
    expect(vetoedParaphrases.length).toBeLessThanOrEqual(2);
  });
});
