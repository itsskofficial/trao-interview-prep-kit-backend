import { similarity, type Embedder, type EmbeddingKind } from "./embedder";
import { DUPLICATE_THRESHOLD } from "./thresholds";

/**
 * Words that name a specific thing: "Node.js", "JVM", "useMemo", "PostgreSQL", "CI", "C++".
 * Recognised by shape, not from a list: a capital or digit after the first letter, a symbol
 * inside the word, or a capitalised word that is not opening a sentence.
 */
export function namedTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const sentences = text.split(/(?<=[.?!:])\s+/);
  for (const sentence of sentences) {
    const words = sentence.match(/[A-Za-z][A-Za-z0-9+#.]*[A-Za-z0-9+#]|[A-Za-z]/g) ?? [];
    words.forEach((word, index) => {
      const shaped = /[a-z][A-Z]|[A-Za-z]\d|[+#]|[a-z]\.[a-z]/.test(word) || (/^[A-Z]{2,}s?$/.test(word) && word.length <= 8);
      const capitalisedInside = index > 0 && /^[A-Z][a-z]+/.test(word) && word !== "I";
      if (shaped || capitalisedInside) terms.add(canonical(word));
    });
  }
  return terms;
}

/** "Postgres" and "PostgreSQL", "Node" and "Node.js", "K8s" and "Kubernetes" are the same thing. */
function canonical(word: string): string {
  // "APIs" is "API"; "AWS" and "iOS" are not plurals.
  const lower = (/[A-Z]$/.test(word) ? word : word.replace(/s$/, "")).toLowerCase();
  const ALIASES: Record<string, string> = { postgre: "postgresql", postgres: "postgresql", node: "node.js", nodej: "node.js", "node.j": "node.js", k8: "kubernetes", kubernete: "kubernetes", js: "javascript", ts: "typescript", golang: "go" };
  return ALIASES[lower] ?? lower;
}

/**
 * Two questions that each name something the other does not are different questions, however
 * alike they read: a memory leak in Node.js and a memory leak on the JVM, useMemo and useEffect.
 * Embeddings put such pairs as close together as real paraphrases, so this is decided in code.
 */
export function nameDifferentThings(a: string, b: string): boolean {
  const left = namedTerms(a);
  const right = namedTerms(b);
  const onlyLeft = [...left].some((term) => !right.has(term));
  const onlyRight = [...right].some((term) => !left.has(term));
  return onlyLeft && onlyRight;
}

export function sameQuestion(kind: EmbeddingKind, score: number, a: string, b: string): boolean {
  return score >= DUPLICATE_THRESHOLD[kind] && !nameDifferentThings(a, b);
}

export interface DuplicateGroup<T> {
  kept: T;
  duplicates: T[];
}

export interface DedupeResult<T> {
  /** One per group, in the original order. */
  groups: Array<DuplicateGroup<T>>;
  comparedWith: string;
}

/**
 * Groups items that ask the same thing. The first of a group is the one kept, so whatever order
 * the caller gives is the order of precedence: put what must survive first.
 */
export async function groupDuplicates<T>(
  items: T[],
  textOf: (item: T) => string,
  embedder: Embedder,
  options: { signal?: AbortSignal; comparable?: (a: T, b: T) => boolean } = {},
): Promise<DedupeResult<T>> {
  const { signal, comparable = () => true } = options;
  if (items.length < 2) return { groups: items.map((kept) => ({ kept, duplicates: [] })), comparedWith: "nothing to compare" };

  const texts = items.map(textOf);
  const { kind, source, vectors } = await embedder.embed(texts, signal);
  const groups: Array<DuplicateGroup<T> & { index: number }> = [];

  items.forEach((item, index) => {
    // Compared with the kept question of each group, not with every member: "same as" must not chain A~B~C into A~C.
    const home = groups.find((group) => comparable(group.kept, item) && sameQuestion(kind, similarity(vectors[group.index]!, vectors[index]!), texts[group.index]!, texts[index]!));
    if (home) home.duplicates.push(item);
    else groups.push({ kept: item, duplicates: [], index });
  });

  return { groups: groups.map(({ kept, duplicates }) => ({ kept, duplicates })), comparedWith: source };
}
