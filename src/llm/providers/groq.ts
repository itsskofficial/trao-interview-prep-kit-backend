import { ProviderError, type LlmProvider, type ProviderRequest, type ProviderResponse } from "../types";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** Groq's OpenAI-compatible API. Used as the fallback: its free tier allows far fewer tokens per minute than Gemini's. */
export function groqProvider(options: { apiKey: string; model: string; fetchFn?: typeof fetch }): LlmProvider {
  const { apiKey, model, fetchFn = fetch } = options;

  return {
    name: `groq:${model}`,

    async complete(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
      if (!apiKey) throw new ProviderError("auth", "GROQ_API_KEY is not set.");

      const response = await fetchFn(ENDPOINT, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_completion_tokens: request.maxOutputTokens,
          reasoning_effort: "low",
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.prompt },
          ],
          response_format: { type: "json_schema", json_schema: { name: "response", schema: request.jsonSchema } },
        }),
      });

      if (!response.ok) throw await toProviderError(response);

      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content ?? "";
      if (!text) throw new ProviderError("server", "Groq returned no text.");
      return { text };
    },
  };
}

async function toProviderError(response: Response): Promise<ProviderError> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  const detail = body.error?.message ?? response.statusText;
  const message = `Groq ${response.status}: ${detail}`;

  if (response.status === 429) {
    // "... tokens per day (TPD)" or "requests per day (RPD)": waiting a minute will not help.
    if (/per day|\b(TPD|RPD)\b/i.test(detail)) return new ProviderError("quota_exhausted", message);
    const seconds = Number(response.headers.get("retry-after"));
    return new ProviderError("rate_limit", message, Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined);
  }
  if (response.status === 401 || response.status === 403) return new ProviderError("auth", message);
  if (response.status >= 500) return new ProviderError("server", message);
  return new ProviderError("bad_request", message);
}
