import { z } from "zod";
import { parseModelJson } from "./json";
import { estimateTokens, type RateLimiter } from "./rate-limiter";
import {
  LlmError,
  ProviderError,
  systemClock,
  type Clock,
  type LlmClient,
  type LlmProvider,
  type LlmRequest,
  type ProviderRequest,
} from "./types";

export interface ProviderSlot {
  provider: LlmProvider;
  limiter: RateLimiter;
}

export interface LlmClientOptions {
  /** Tried in order. A later provider is used only when an earlier one is out of quota or misconfigured. */
  providers: ProviderSlot[];
  clock?: Clock;
  /** Retries per provider for rate limits, 5xx, timeouts and network errors. */
  maxRetries?: number;
  timeoutMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  onEvent?: (event: LlmEvent) => void;
}

export type LlmEvent =
  | { type: "retry"; step: string; provider: string; reason: string; waitMs: number }
  | { type: "repair"; step: string; provider: string; issues: string }
  | { type: "failover"; step: string; from: string; reason: string };

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function createLlmClient(options: LlmClientOptions): LlmClient {
  const {
    providers,
    clock = systemClock,
    maxRetries = 4,
    timeoutMs = 60_000,
    baseBackoffMs = 2_000,
    maxBackoffMs = 60_000,
    random = Math.random,
    onEvent = () => undefined,
  } = options;

  async function callWithRetry(slot: ProviderSlot, step: string, request: ProviderRequest): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      await slot.limiter.acquire(estimateTokens(request.system + request.prompt, request.maxOutputTokens));
      try {
        const response = await slot.provider.complete(request, AbortSignal.timeout(timeoutMs));
        return response.text;
      } catch (error) {
        const failure = toProviderError(error);
        if (!failure.retryable || attempt >= maxRetries) throw failure;

        // The provider's own Retry-After wins; otherwise exponential backoff with jitter.
        const backoff = Math.min(baseBackoffMs * 2 ** attempt, maxBackoffMs);
        const waitMs = failure.retryAfterMs ?? Math.round(backoff * (0.5 + random() / 2));
        onEvent({ type: "retry", step, provider: slot.provider.name, reason: failure.message, waitMs });
        await clock.sleep(waitMs);
      }
    }
  }

  async function generateWith<T>(slot: ProviderSlot, request: LlmRequest<T>): Promise<T> {
    const base: ProviderRequest = {
      system: request.system,
      prompt: request.prompt,
      jsonSchema: toProviderJsonSchema(request.schema),
      maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };

    const first = check(request.schema, await callWithRetry(slot, request.step, base));
    if (first.ok) return first.value;

    // One repair attempt: show the model exactly what was wrong with its answer.
    onEvent({ type: "repair", step: request.step, provider: slot.provider.name, issues: first.issues });
    const repairPrompt = `${request.prompt}\n\nYour previous answer was rejected:\n${first.issues}\nAnswer again with valid JSON that matches the schema exactly, and nothing else.`;
    const second = check(request.schema, await callWithRetry(slot, request.step, { ...base, prompt: repairPrompt }));
    if (second.ok) return second.value;

    throw new LlmError("LLM_INVALID_OUTPUT", `${request.step}: model output was invalid twice. ${second.issues}`);
  }

  return {
    async generate<T>(request: LlmRequest<T>): Promise<T> {
      const failures: string[] = [];
      for (const slot of providers) {
        try {
          return await generateWith(slot, request);
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          failures.push(`${slot.provider.name}: ${error.message}`);
          onEvent({ type: "failover", step: request.step, from: slot.provider.name, reason: error.message });
        }
      }
      throw new LlmError("LLM_UNAVAILABLE", `${request.step}: no provider could answer. ${failures.join(" | ")}`);
    },
  };
}

function check<T>(schema: z.ZodType<T>, text: string): { ok: true; value: T } | { ok: false; issues: string } {
  const json = parseModelJson(text);
  if (!json.ok) return { ok: false, issues: json.error };

  const parsed = schema.safeParse(json.value);
  if (parsed.success) return { ok: true, value: parsed.data };

  const issues = parsed.error.issues
    .slice(0, 10)
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  return { ok: false, issues };
}

function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return jsonSchema;
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new ProviderError("timeout", "Request timed out.");
  }
  return new ProviderError("network", error instanceof Error ? error.message : String(error));
}
