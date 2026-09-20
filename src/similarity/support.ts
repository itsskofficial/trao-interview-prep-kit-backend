import { isQuotedFrom, wordOverlap } from "../extraction/evidence";
import { similarity, type Embedder, type EmbeddingKind } from "./embedder";
import { SUPPORT_THRESHOLD } from "./thresholds";

/** Something the model says a source states, with the words it says state it. */
export interface Claim {
  text: string;
  evidence: string;
}

export interface SupportedClaim {
  text: string;
  /** Verbatim from the source. */
  quote: string;
}

export interface SupportResult {
  kept: SupportedClaim[];
  dropped: Array<{ text: string; reason: string }>;
  /** How meaning was compared, when it had to be. */
  comparedWith?: string;
}

/**
 * The same rule as for requirements, applied to what the model says about a company: a claim
 * stands only if it comes with words that are really in the source, and those words really
 * say it.
 *
 *  1. The quote must be in the source verbatim. Code checks; a quote that is not there ends it.
 *  2. If the claim itself is the source's own wording (a page that lists "Phone screen"), that is enough.
 *  3. Otherwise the claim and its quote are compared by meaning. A model that invents a stage has
 *     to cite some sentence for it, and an unrelated sentence does not pass.
 *
 * Without semantic embeddings step 3 falls back to shared words, which is stricter: a faithful
 * paraphrase with no word in common is dropped. Reporting too few stages is the safe direction.
 */
export async function checkSupport(claims: Claim[], source: string, embedder: Embedder, signal?: AbortSignal): Promise<SupportResult> {
  const kept: SupportedClaim[] = [];
  const dropped: SupportResult["dropped"] = [];
  const undecided: Claim[] = [];

  for (const raw of claims) {
    const claim = { text: raw.text.trim(), evidence: raw.evidence.trim() };
    if (!claim.text) continue;
    if (!source || !isQuotedFrom(source, claim.evidence)) {
      dropped.push({ text: claim.text, reason: "the quoted words are not in the source" });
    } else if (isQuotedFrom(source, claim.text) || isQuotedFrom(claim.evidence, claim.text)) {
      kept.push({ text: claim.text, quote: claim.evidence });
    } else {
      undecided.push(claim);
    }
  }

  let comparedWith: string | undefined;
  if (undecided.length > 0) {
    const embeddings = await embedder.embed(undecided.flatMap((claim) => [claim.text, claim.evidence]), signal);
    comparedWith = embeddings.source;
    undecided.forEach((claim, index) => {
      const score = similarity(embeddings.vectors[index * 2]!, embeddings.vectors[index * 2 + 1]!);
      if (supports(embeddings.kind, score, claim)) kept.push({ text: claim.text, quote: claim.evidence });
      else dropped.push({ text: claim.text, reason: "the quoted words do not say this" });
    });
  }

  // Stages are in the order the company publishes them; checking must not shuffle them.
  const position = new Map(claims.map((claim, index) => [claim.text.trim(), index]));
  kept.sort((a, b) => (position.get(a.text) ?? 0) - (position.get(b.text) ?? 0));
  return { kept, dropped, ...(comparedWith ? { comparedWith } : {}) };
}

function supports(kind: EmbeddingKind, score: number, claim: Claim): boolean {
  if (kind === "semantic") return score >= SUPPORT_THRESHOLD.semantic;
  // Hashed word vectors say nothing a direct word count does not say more plainly.
  return wordOverlap(claim.text, claim.evidence) >= SUPPORT_THRESHOLD.lexicalOverlap;
}
