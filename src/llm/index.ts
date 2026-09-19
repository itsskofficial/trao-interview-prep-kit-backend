import type { Config } from "../config";
import { createLlmClient, type LlmEvent, type ProviderSlot } from "./client";
import { geminiProvider } from "./providers/gemini";
import { RateLimiter } from "./rate-limiter";
import { withReplayCache } from "./replay-cache";
import type { LlmClient } from "./types";

export { LlmError } from "./types";
export type { LlmClient, LlmRequest } from "./types";
export type { LlmEvent } from "./client";

/** The one place that turns configuration into a ready client. */
export function createLlmClientFromConfig(config: Config, onEvent?: (event: LlmEvent) => void): LlmClient {
  const cached = (slot: ProviderSlot): ProviderSlot =>
    config.LLM_REPLAY_CACHE ? { ...slot, provider: withReplayCache(slot.provider, config.LLM_REPLAY_CACHE) } : slot;

  const gemini: ProviderSlot = {
    provider: geminiProvider({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL }),
    limiter: new RateLimiter({ requestsPerMinute: config.GEMINI_RPM, tokensPerMinute: config.GEMINI_TPM }),
  };

  return createLlmClient({
    providers: [gemini].map(cached),
    timeoutMs: config.LLM_TIMEOUT_MS,
    onEvent,
  });
}
