import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeClock, fakeLlmClient, fakeProvider } from "../src/llm/fake";
import { LlmError, ProviderError } from "../src/llm/types";
import type { LlmEvent } from "../src/llm/client";

const Fruits = z.object({ fruits: z.array(z.string()).min(1) });
const request = { step: "test", system: "Return JSON.", prompt: "List fruits.", schema: Fruits };

describe("LLM client", () => {
  it("returns data validated against the requested schema", async () => {
    const client = fakeLlmClient([fakeProvider([{ fruits: ["apple"] }])]);
    await expect(client.generate(request)).resolves.toEqual({ fruits: ["apple"] });
  });

  it("sends the provider a JSON schema for the requested shape", async () => {
    const provider = fakeProvider([{ fruits: ["apple"] }]);
    await fakeLlmClient([provider]).generate(request);
    expect(provider.requests[0]!.jsonSchema).toMatchObject({ type: "object", required: ["fruits"] });
  });

  it("accepts JSON wrapped in a code fence or prose", async () => {
    const client = fakeLlmClient([fakeProvider(['Sure! ```json\n{"fruits":["pear"]}\n```'])]);
    await expect(client.generate(request)).resolves.toEqual({ fruits: ["pear"] });
  });

  it("repairs once: invalid output then valid output succeeds, and the model is told what was wrong", async () => {
    const provider = fakeProvider(["not json at all", { fruits: ["plum"] }]);
    const result = await fakeLlmClient([provider]).generate(request);
    expect(result).toEqual({ fruits: ["plum"] });
    expect(provider.requests[1]!.prompt).toContain("Your previous answer was rejected");
  });

  it("names the failing field when the JSON is valid but the shape is wrong", async () => {
    const provider = fakeProvider([{ fruits: [] }, { fruits: ["fig"] }]);
    await fakeLlmClient([provider]).generate(request);
    expect(provider.requests[1]!.prompt).toContain("fruits");
  });

  it("fails with LLM_INVALID_OUTPUT after two invalid answers, without trying a third time", async () => {
    const provider = fakeProvider(["nope", { wrong: true }, { fruits: ["never reached"] }]);
    const failure = await fakeLlmClient([provider]).generate(request).catch((error) => error);
    expect(failure).toBeInstanceOf(LlmError);
    expect(failure.code).toBe("LLM_INVALID_OUTPUT");
    expect(provider.requests).toHaveLength(2);
  });

  it("waits for the provider's Retry-After on a rate limit, then succeeds", async () => {
    const clock = fakeClock();
    const provider = fakeProvider([new ProviderError("rate_limit", "slow down", 23_000), { fruits: ["kiwi"] }]);
    const result = await fakeLlmClient([provider], { clock }).generate(request);
    expect(result).toEqual({ fruits: ["kiwi"] });
    expect(clock.sleeps).toEqual([23_000]);
  });

  it("backs off exponentially on server errors", async () => {
    const clock = fakeClock();
    const boom = () => new ProviderError("server", "503");
    const provider = fakeProvider([boom(), boom(), boom(), { fruits: ["lime"] }]);
    await fakeLlmClient([provider], { clock, baseBackoffMs: 1000 }).generate(request);
    // random() is fixed at 0.5, so each wait is 75% of 1s, 2s, 4s.
    expect(clock.sleeps).toEqual([750, 1500, 3000]);
  });

  it("retries a timeout and a network error", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const provider = fakeProvider([timeout, new Error("ECONNRESET"), { fruits: ["date"] }]);
    await expect(fakeLlmClient([provider]).generate(request)).resolves.toEqual({ fruits: ["date"] });
  });

  it("gives up after maxRetries and reports LLM_UNAVAILABLE", async () => {
    const boom = () => new ProviderError("server", "503");
    const provider = fakeProvider([boom(), boom(), boom()]);
    const failure = await fakeLlmClient([provider], { maxRetries: 2 }).generate(request).catch((error) => error);
    expect(failure.code).toBe("LLM_UNAVAILABLE");
    expect(provider.requests).toHaveLength(3);
  });

  it("does not retry an exhausted daily quota; it fails over to the next provider", async () => {
    const events: LlmEvent[] = [];
    const primary = fakeProvider([new ProviderError("quota_exhausted", "daily limit")], "primary");
    const fallback = fakeProvider([{ fruits: ["mango"] }], "fallback");
    const result = await fakeLlmClient([primary, fallback], { onEvent: (e) => events.push(e) }).generate(request);
    expect(result).toEqual({ fruits: ["mango"] });
    expect(primary.requests).toHaveLength(1);
    expect(events).toContainEqual({ type: "failover", step: "test", from: "primary", reason: "daily limit" });
  });

  it("reports every provider's failure when none can answer", async () => {
    const primary = fakeProvider([new ProviderError("auth", "no key")], "primary");
    const fallback = fakeProvider([new ProviderError("quota_exhausted", "daily limit")], "fallback");
    const failure = await fakeLlmClient([primary, fallback]).generate(request).catch((error) => error);
    expect(failure.code).toBe("LLM_UNAVAILABLE");
    expect(failure.message).toContain("primary: no key");
    expect(failure.message).toContain("fallback: daily limit");
  });
});
