/**
 * Pulls a JSON value out of a model response. Models wrap JSON in code fences
 * or add a sentence before it even when told not to.
 */
export function parseModelJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates = [text.trim(), stripCodeFence(text), outermostJson(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: "Response was not valid JSON." };
}

function stripCodeFence(text: string): string | undefined {
  return /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]?.trim();
}

function outermostJson(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const close = text[start] === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1) : undefined;
}
