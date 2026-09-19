import { RateLimiter } from "./rate-limiter";
import { createLlmClient, type LlmClientOptions } from "./client";
import type { Clock, LlmClient, LlmProvider, ProviderRequest } from "./types";

type Scripted = string | object | Error | ((request: ProviderRequest) => string | object);

/**
 * A provider that replays scripted answers in order and records what it was
 * asked. Objects are sent back as JSON; errors are thrown.
 */
export function fakeProvider(script: Scripted[], name = "fake"): LlmProvider & { requests: ProviderRequest[] } {
  const remaining = [...script];
  const requests: ProviderRequest[] = [];

  return {
    name,
    requests,
    async complete(request) {
      requests.push(request);
      const next = remaining.shift();
      if (next === undefined) throw new Error(`${name}: no scripted response left for call ${requests.length}`);
      if (next instanceof Error) throw next;
      const answer = typeof next === "function" ? next(request) : next;
      return { text: typeof answer === "string" ? answer : JSON.stringify(answer) };
    },
  };
}

/** A clock that never really waits: sleeping just moves time forward. */
export function fakeClock(start = 0): Clock & { sleeps: number[] } {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

/** A client over fake providers with generous limits and no real waiting. */
export function fakeLlmClient(
  providers: LlmProvider[],
  overrides: Partial<LlmClientOptions> = {},
): LlmClient {
  const clock = overrides.clock ?? fakeClock();
  return createLlmClient({
    clock,
    random: () => 0.5,
    providers: providers.map((provider) => ({
      provider,
      limiter: new RateLimiter({ requestsPerMinute: 1000, tokensPerMinute: 10_000_000 }, clock),
    })),
    ...overrides,
  });
}
