/**
 * Two checks in the pipeline are about meaning rather than wording: whether two
 * questions ask the same thing, and whether a sentence on a page really supports
 * a claim made about it. Counting shared words answers neither well, so both
 * compare embeddings.
 *
 * Embeddings are an aid, never a dependency. With no key, offline, or when the
 * call fails, the lexical embedder below stands in, and callers are told which
 * kind they got because the two are not on the same scale.
 */
export type EmbeddingKind = "semantic" | "lexical";

export interface Embeddings {
  kind: EmbeddingKind;
  /** Which model or method produced the vectors, for the run trace. */
  source: string;
  /** Unit length, one per input text, in input order. */
  vectors: number[][];
}

export interface Embedder {
  embed(texts: string[], signal?: AbortSignal): Promise<Embeddings>;
}

/** Vectors are unit length, so this is their cosine similarity. */
export function similarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

const MAX_TEXT_CHARS = 2_000;
const GEMINI_BATCH = 100;
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiEmbedderOptions {
  apiKey: string;
  model: string;
  /** Google counts every text in a batch as one request against the per-minute limit. */
  textsPerMinute: number;
  timeoutMs?: number;
  now?: () => number;
  fetchFn?: typeof fetch;
}

/** Gemini's embedding endpoint. Its free quota is separate from the generation quota, so it costs the pipeline no model calls. */
export function geminiEmbedder(options: GeminiEmbedderOptions): Embedder {
  const { apiKey, model, timeoutMs = 15_000, fetchFn = fetch, now = Date.now } = options;
  let sent: Array<{ at: number; texts: number }> = [];

  // Never waits. A comparison is an aid to the pipeline; when this minute is spent the caller falls
  // back to the lexical embedder at once rather than holding a kit up for something it can do without.
  const spend = (texts: number) => {
    sent = sent.filter((entry) => now() - entry.at < 60_000);
    const used = sent.reduce((sum, entry) => sum + entry.texts, 0);
    if (used + texts > options.textsPerMinute) throw new Error(`Embedding budget for this minute is spent (${used} of ${options.textsPerMinute} texts).`);
    sent.push({ at: now(), texts });
  };

  return {
    async embed(texts, signal) {
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");
      const vectors: number[][] = [];

      for (let start = 0; start < texts.length; start += GEMINI_BATCH) {
        const batch = texts.slice(start, start + GEMINI_BATCH).map((text) => text.slice(0, MAX_TEXT_CHARS) || " ");
        spend(batch.length);
        const response = await fetchFn(`${BASE_URL}/${model}:batchEmbedContents`, {
          method: "POST",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            requests: batch.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: "SEMANTIC_SIMILARITY", outputDimensionality: 768 })),
          }),
        });
        if (!response.ok) throw new Error(`Gemini embeddings ${response.status}`);

        const body = (await response.json()) as { embeddings?: Array<{ values?: number[] }> };
        if (body.embeddings?.length !== batch.length) throw new Error("Gemini embeddings: wrong number of vectors returned.");
        // Truncated dimensions do not come back normalised.
        for (const embedding of body.embeddings) vectors.push(unit(embedding.values ?? []));
      }
      return { kind: "semantic", source: `gemini:${model}`, vectors };
    },
  };
}

const LEXICAL_DIMENSIONS = 4096;
const STOPWORDS = new Set(
  "a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to us was we were what when where which who why will with would you your about tell time describe explain walk through".split(" "),
);

/**
 * Feature hashing over word stems and adjacent pairs. It knows nothing about meaning, only wording,
 * but it needs no network, is deterministic, and is good enough to catch a question repeated nearly
 * word for word, which is the common case.
 */
export function lexicalEmbedder(): Embedder {
  return {
    async embed(texts) {
      return { kind: "lexical", source: "lexical", vectors: texts.map(lexicalVector) };
    },
  };
}

function lexicalVector(text: string): number[] {
  const vector = new Array<number>(LEXICAL_DIMENSIONS).fill(0);
  const words = (text.toLowerCase().match(/[a-z0-9+#.]*[a-z0-9+#]/g) ?? []).filter((word) => !STOPWORDS.has(word)).map(stem);
  words.forEach((word, index) => {
    vector[bucket(word)]! += 1;
    if (index > 0) vector[bucket(`${words[index - 1]} ${word}`)]! += 0.5;
  });
  return unit(vector);
}

/** Enough to make "mentoring", "mentored" and "mentors" one word. Not a linguistically correct stemmer, and it does not need to be. */
function stem(word: string): string {
  if (word.length <= 4) return word;
  return word.replace(/(ing|ed|es|s|ly)$/, "").replace(/(.)\1$/, "$1");
}

/** FNV-1a: small, fast and evenly spread, which is all feature hashing asks of it. */
function bucket(feature: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < feature.length; i++) {
    hash ^= feature.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % LEXICAL_DIMENSIONS;
}

function unit(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}

/** The primary embedder while it works; the fallback, with a word about why, when it does not. An embedding failure never fails a kit. */
export function withFallback(primary: Embedder, fallback: Embedder, onFallback: (reason: string) => void = () => undefined): Embedder {
  return {
    async embed(texts, signal) {
      try {
        return await primary.embed(texts, signal);
      } catch (error) {
        // The caller giving up is not the embedder failing.
        signal?.throwIfAborted();
        onFallback(error instanceof Error ? error.message : String(error));
        return fallback.embed(texts, signal);
      }
    },
  };
}
