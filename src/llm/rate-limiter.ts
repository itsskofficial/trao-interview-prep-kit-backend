import { systemClock, type Clock } from "./types";

const WINDOW_MS = 60_000;

export interface RateLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
}

/**
 * Sliding one-minute window over both requests and tokens. Free tiers limit
 * tokens per minute as well as requests, so both are counted before a call is
 * sent rather than discovered from a 429. Callers queue in arrival order.
 */
export class RateLimiter {
  private events: Array<{ at: number; tokens: number }> = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly limits: RateLimits,
    private readonly clock: Clock = systemClock,
  ) {}

  acquire(estimatedTokens: number): Promise<void> {
    // A single request larger than the whole budget would otherwise wait forever.
    const tokens = Math.min(estimatedTokens, this.limits.tokensPerMinute);
    const turn = this.queue.then(() => this.waitForRoom(tokens));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async waitForRoom(tokens: number): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.events = this.events.filter((event) => now - event.at < WINDOW_MS);

      const usedTokens = this.events.reduce((sum, event) => sum + event.tokens, 0);
      const hasRoom =
        this.events.length < this.limits.requestsPerMinute && usedTokens + tokens <= this.limits.tokensPerMinute;
      if (hasRoom) {
        this.events.push({ at: now, tokens });
        return;
      }
      // Room can only appear when the oldest event leaves the window.
      await this.clock.sleep(this.events[0]!.at + WINDOW_MS - now + 1);
    }
  }
}

/** What an answer in this application actually runs to. The ceiling (4,096) is a limit, not an expectation. */
const TYPICAL_OUTPUT_TOKENS = 1_500;

/**
 * About four characters per token for the prompt, plus a typical answer. Reserving the output
 * ceiling instead would let a provider with a small per-minute budget make one call a minute.
 */
export function estimateTokens(text: string, maxOutputTokens: number): number {
  return Math.ceil(text.length / 4) + Math.min(maxOutputTokens, TYPICAL_OUTPUT_TOKENS);
}
