import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmProvider } from "./types";

/**
 * Development aid: stores each answer on disk keyed by the exact request, so
 * re-running the pipeline while working on something else does not spend the
 * free tier's daily quota. Off unless LLM_REPLAY_CACHE is set.
 */
export function withReplayCache(provider: LlmProvider, directory: string): LlmProvider {
  return {
    name: provider.name,
    async complete(request, signal) {
      const key = createHash("sha256").update(provider.name).update(JSON.stringify(request)).digest("hex");
      const file = path.join(directory, `${key}.json`);

      const cached = await readFile(file, "utf8").catch(() => undefined);
      if (cached !== undefined) return JSON.parse(cached);

      const response = await provider.complete(request, signal);
      await mkdir(directory, { recursive: true });
      await writeFile(file, JSON.stringify(response), "utf8");
      return response;
    },
  };
}
