import type { z } from "zod";

/** What a pipeline step asks for: a prompt and the shape it wants back. */
export interface LlmRequest<T> {
  /** Pipeline step name, used in logs and error messages. */
  step: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
  /** Told about every HTTP call made for this request, whatever its outcome. This is what a run trace is built from. */
  onCall?: (record: LlmCallRecord) => void;
}

/** Tokens as the provider counted them, not as we estimated them. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** One HTTP call to one provider. Never holds prompt or answer text: a trace is safe to store and to show. */
export interface LlmCallRecord {
  step: string;
  provider: string;
  /** 1 for the first try on this provider, 2 for the first retry, and so on. */
  attempt: number;
  /** "repair" is the second ask, made after the first answer failed validation. */
  kind: "answer" | "repair";
  outcome: "ok" | "invalid_output" | ProviderErrorKind;
  /** Time spent waiting for room in the rate limiter before the call was sent. */
  queuedMs: number;
  latencyMs: number;
  usage?: TokenUsage;
  error?: string;
}

export interface LlmClient {
  generate<T>(request: LlmRequest<T>): Promise<T>;
}

export interface ProviderRequest {
  system: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface ProviderResponse {
  text: string;
  usage?: TokenUsage;
}

/** One model behind one API. Providers translate HTTP failures into ProviderError and nothing else. */
export interface LlmProvider {
  name: string;
  complete(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>;
}

export type ProviderErrorKind =
  | "rate_limit" // per-minute limit: wait and retry
  | "quota_exhausted" // daily limit: retrying is pointless, fail over
  | "server" // 5xx
  | "timeout"
  | "network"
  | "auth" // missing or rejected key
  | "bad_request";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "server" || this.kind === "timeout" || this.kind === "network";
  }
}

export type LlmErrorCode = "LLM_UNAVAILABLE" | "LLM_INVALID_OUTPUT";

/** What the pipeline sees when a call could not be completed on any provider. */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
