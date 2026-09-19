import { ProviderError, type LlmProvider, type ProviderRequest, type ProviderResponse } from "../types";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export function geminiProvider(options: { apiKey: string; model: string; fetchFn?: typeof fetch }): LlmProvider {
  const { apiKey, model, fetchFn = fetch } = options;

  return {
    name: `gemini:${model}`,

    async complete(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
      if (!apiKey) throw new ProviderError("auth", "GEMINI_API_KEY is not set.");

      const response = await fetchFn(`${BASE_URL}/${model}:generateContent`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: request.maxOutputTokens,
            // Extraction and drafting need no long reasoning; minimal thinking cut a call from 13s to under 3s.
            thinkingConfig: { thinkingLevel: "minimal" },
            responseMimeType: "application/json",
            responseJsonSchema: request.jsonSchema,
          },
        }),
      });

      if (!response.ok) throw await toProviderError(response);

      const body = (await response.json()) as GeminiResponse;
      const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
      if (!text) {
        const reason = body.candidates?.[0]?.finishReason ?? body.promptFeedback?.blockReason ?? "empty response";
        // A blocked or cut-off answer will be blocked or cut off again: asking five more times only spends the case's time.
        const deterministic = /SAFETY|RECITATION|MAX_TOKENS|PROHIBITED|BLOCKLIST|SPII|OTHER/.test(reason);
        throw new ProviderError(deterministic ? "bad_request" : "server", `Gemini returned no text (${reason}).`);
      }
      return { text };
    },
  };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

interface GeminiErrorBody {
  error?: {
    message?: string;
    details?: Array<{
      "@type"?: string;
      retryDelay?: string;
      violations?: Array<{ quotaId?: string }>;
    }>;
  };
}

async function toProviderError(response: Response): Promise<ProviderError> {
  const body = (await response.json().catch(() => ({}))) as GeminiErrorBody;
  const message = `Gemini ${response.status}: ${body.error?.message ?? response.statusText}`;
  const details = body.error?.details ?? [];

  if (response.status === 429) {
    // A per-day quota will not recover by waiting a minute; the client should fail over instead.
    const daily = details.some((detail) => detail.violations?.some((v) => /PerDay/i.test(v.quotaId ?? "")));
    if (daily) return new ProviderError("quota_exhausted", message);
    return new ProviderError("rate_limit", message, retryDelayMs(response, details));
  }
  if (response.status === 401 || response.status === 403) return new ProviderError("auth", message);
  if (response.status >= 500) return new ProviderError("server", message);
  return new ProviderError("bad_request", message);
}

function retryDelayMs(response: Response, details: NonNullable<GeminiErrorBody["error"]>["details"]): number | undefined {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;

  const delay = details?.find((detail) => detail.retryDelay)?.retryDelay; // e.g. "23s"
  const seconds = delay ? Number.parseFloat(delay) : Number.NaN;
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
}
