import { z } from "zod";
import { parseModelJson } from "./json";
import { estimatePromptTokens, estimateTokens, type RateLimiter } from "./rate-limiter";
import {
  LlmError,
  ProviderError,
  systemClock,
  type Clock,
  type LlmCallRecord,
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

  /** One validated answer from one provider, retrying what is worth retrying. Every HTTP call is reported to `call.report`. */
  async function callWithRetry<T>(slot: ProviderSlot, call: Call<T>, request: ProviderRequest): Promise<Checked<T>> {
    const { step } = call;
    const promptText = request.system + request.prompt;
    for (let attempt = 0; ; attempt++) {
      const queuedAt = clock.now();
      const reservation = await slot.limiter.acquire(estimateTokens(promptText, request.maxOutputTokens));
      const sentAt = clock.now();
      // Observers are told, never obeyed: one that throws must not turn a good answer into a retried "network" failure.
      const record = (fields: Pick<LlmCallRecord, "outcome" | "usage" | "error">): void => {
        try {
          call.report({ step, provider: slot.provider.name, attempt: attempt + 1, kind: call.kind, queuedMs: sentAt - queuedAt, latencyMs: clock.now() - sentAt, ...fields });
        } catch {
          // nothing useful can be done with a broken observer from here
        }
      };

      try {
        const response = await slot.provider.complete(request, AbortSignal.timeout(timeoutMs));
        // The estimate was a guess made before the call; what the provider counted is what its limit is charged.
        if (response.usage) reservation.settle(response.usage.inputTokens + response.usage.outputTokens);
        const checked = check(call.schema, response.text);
        record({ outcome: checked.ok ? "ok" : "invalid_output", usage: response.usage, ...(checked.ok ? {} : { error: firstLine(checked.issues) }) });
        return checked;
      } catch (error) {
        const failure = toProviderError(error);
        // No answer was produced, so only the prompt can have been counted.
        reservation.settle(estimatePromptTokens(promptText));
        record({ outcome: failure.kind, error: firstLine(failure.message) });
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

    const report = request.onCall ?? (() => undefined);
    const first = await callWithRetry(slot, { step: request.step, kind: "answer", schema: request.schema, report }, base);
    if (first.ok) return first.value;

    // One repair attempt: show the model exactly what was wrong with its answer.
    onEvent({ type: "repair", step: request.step, provider: slot.provider.name, issues: first.issues });
    const repairPrompt = `${request.prompt}\n\nYour previous answer was rejected:\n${first.issues}\nAnswer again with valid JSON that matches the schema exactly, and nothing else.`;
    const second = await callWithRetry(slot, { step: request.step, kind: "repair", schema: request.schema, report }, { ...base, prompt: repairPrompt });
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

type Checked<T> = { ok: true; value: T } | { ok: false; issues: string };

interface Call<T> {
  step: string;
  kind: LlmCallRecord["kind"];
  schema: z.ZodType<T>;
  report: (record: LlmCallRecord) => void;
}

/** Error text in a trace is one short line: enough to see what happened, never a dump of what the provider sent back. */
function firstLine(message: string): string {
  return scrubSecrets(message.split("\n")[0]!).slice(0, 200);
}

/**
 * Keys travel in headers and are never put in a message by this code, but a trace is stored and shown,
 * and an upstream error can quote anything. Whatever looks like a credential is removed on the way in.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b(AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z_-]{20,})/g, "[redacted]")
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[redacted]@");
}

function check<T>(schema: z.ZodType<T>, text: string): Checked<T> {
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
