import { describe, expect, it } from "vitest";
import { fakeClock } from "../src/llm/fake";
import { RateLimiter, estimateTokens } from "../src/llm/rate-limiter";

describe("RateLimiter", () => {
  it("lets requests through immediately while under both limits", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 3, tokensPerMinute: 1000 }, clock);
    await Promise.all([limiter.acquire(100), limiter.acquire(100), limiter.acquire(100)]);
    expect(clock.sleeps).toEqual([]);
  });

  it("holds the next request until the oldest one leaves the one-minute window", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 2, tokensPerMinute: 1000 }, clock);
    await limiter.acquire(1);
    await clock.sleep(10_000);
    await limiter.acquire(1);
    clock.sleeps.length = 0;

    await limiter.acquire(1);
    expect(clock.sleeps).toEqual([50_001]);
  });

  it("limits tokens per minute even when requests are under their limit", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 100, tokensPerMinute: 1000 }, clock);
    await limiter.acquire(600);
    await limiter.acquire(600);
    expect(clock.sleeps).toEqual([60_001]);
  });

  it("serves queued callers in arrival order", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 1, tokensPerMinute: 1000 }, clock);
    const order: string[] = [];
    await Promise.all(["a", "b", "c"].map((name) => limiter.acquire(1).then(() => order.push(name))));
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("does not wait forever for a request bigger than the whole token budget", async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 10, tokensPerMinute: 1000 }, fakeClock());
    await expect(limiter.acquire(5000)).resolves.toBeUndefined();
  });

  it("estimates tokens from prompt length plus a typical answer, not the output ceiling", () => {
    expect(estimateTokens("x".repeat(400), 1000)).toBe(1100);
    expect(estimateTokens("x".repeat(400), 4096)).toBe(1600);
  });
});
