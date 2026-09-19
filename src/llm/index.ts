import type { Config } from "../config";
import { createLlmClient, type LlmEvent, type ProviderSlot } from "./client";
import { geminiProvider } from "./providers/gemini";
import { groqProvider } from "./providers/groq";
import { offlineProvider } from "./providers/offline";
import { RateLimiter } from "./rate-limiter";
import { withReplayCache } from "./replay-cache";
import type { LlmClient } from "./types";

export { LlmError } from "./types";
export type { LlmClient, LlmRequest } from "./types";
export type { LlmEvent } from "./client";

/** The one place that turns configuration into a ready client. */
export function createLlmClientFromConfig(config: Config, onEvent?: (event: LlmEvent) => void): LlmClient {
  if (config.LLM_PROVIDER === "offline") {
    const unlimited = new RateLimiter({ requestsPerMinute: 10_000, tokensPerMinute: 100_000_000 });
    return createLlmClient({ providers: [{ provider: offlineProvider(), limiter: unlimited }], onEvent });
  }

  const cached = (slot: ProviderSlot): ProviderSlot =>
    config.LLM_REPLAY_CACHE ? { ...slot, provider: withReplayCache(slot.provider, config.LLM_REPLAY_CACHE) } : slot;

  const gemini: ProviderSlot = {
    provider: geminiProvider({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL }),
    limiter: new RateLimiter({ requestsPerMinute: config.GEMINI_RPM, tokensPerMinute: config.GEMINI_TPM }),
  };

  const groq: ProviderSlot = {
    provider: groqProvider({ apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL }),
    limiter: new RateLimiter({ requestsPerMinute: config.GROQ_RPM, tokensPerMinute: config.GROQ_TPM }),
  };

  // LLM_PROVIDER chooses who goes first. The other is a fallback, used when the first runs out of
  // daily quota or fails outright, and only if a key for it was provided.
  const [primary, fallback] = config.LLM_PROVIDER === "groq" ? [groq, gemini] : [gemini, groq];
  const fallbackKey = config.LLM_PROVIDER === "groq" ? config.GEMINI_API_KEY : config.GROQ_API_KEY;

  return createLlmClient({
    providers: [primary, ...(fallbackKey ? [fallback] : [])].map(cached),
    timeoutMs: config.LLM_TIMEOUT_MS,
    onEvent,
  });
}
