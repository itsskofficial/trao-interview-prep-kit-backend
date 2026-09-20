import type { Config } from "../config";
import { geminiEmbedder, lexicalEmbedder, withFallback, type Embedder } from "./embedder";

export { lexicalEmbedder } from "./embedder";
export type { Embedder } from "./embedder";

/** Semantic when there is a Gemini key and it has not been turned off; lexical otherwise, and whenever the semantic call fails. */
export function createEmbedderFromConfig(config: Config, onFallback?: (reason: string) => void): Embedder {
  const lexical = lexicalEmbedder();
  if (config.LLM_PROVIDER === "offline" || !config.GEMINI_API_KEY || config.GEMINI_EMBEDDING_MODEL === "off") return lexical;
  return withFallback(geminiEmbedder({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_EMBEDDING_MODEL, textsPerMinute: config.GEMINI_EMBEDDING_RPM }), lexical, onFallback);
}
