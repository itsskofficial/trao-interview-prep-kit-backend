import robotsParser from "robots-parser";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { BlockedAddressError, checkUrl, guardedLookup, isPrivateAddress } from "./url-guard";

export const USER_AGENT = "InterviewPrepKitBot/1.0 (+https://github.com/itsskofficial/trao-interview-prep-kit-backend)";

export type SkipReason =
  | "invalid_url"
  | "blocked_address"
  | "robots_disallowed"
  | "http_error"
  | "timeout"
  | "network"
  | "unsupported_content_type"
  | "too_large"
  | "too_many_redirects";

export type FetchResult =
  | { ok: true; url: string; status: number; contentType: string; body: string }
  | { ok: false; url: string; reason: SkipReason; detail: string; status?: number };

export type Accept = "html" | "xml" | "json";

/** A single HTTP exchange either finishes or points somewhere else. */
type Exchange = FetchResult | { redirectTo: string };

export interface FetcherOptions {
  /** Permit loopback and private addresses. True for local tools and tests, false on a deployed server. */
  allowPrivate: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Minimum gap between two requests to the same host. */
  minDelayMs?: number;
  /** Gap used for loopback hosts, where politeness is pointless and only slows a local run. */
  localDelayMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PageFetcher {
  fetchPage(url: string, accept?: Accept): Promise<FetchResult>;
  close(): Promise<void>;
}

const ACCEPT_HEADER: Record<Accept, string> = {
  html: "text/html,application/xhtml+xml",
  xml: "application/xml,text/xml",
  json: "application/json",
};

const ACCEPTED: Record<Accept, RegExp> = {
  json: /^application\/json\b/i,
  html: /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i,
  xml: /^(application\/xml|text\/xml|application\/rss\+xml|application\/atom\+xml|text\/plain)\b/i,
};

/**
 * Fetches pages from the open internet as untrusted input: validated address,
 * robots.txt honoured, bounded size, time and redirects, polite per-host
 * pacing, and backoff on failure. It never throws; every problem comes back as
 * a typed skip reason so one bad source cannot fail a run.
 */
export function createPageFetcher(options: FetcherOptions): PageFetcher {
  const {
    allowPrivate,
    timeoutMs = 10_000,
    maxBytes = 3_000_000,
    maxRedirects = 5,
    minDelayMs = 1_000,
    localDelayMs = 25,
    retries = 2,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const dispatcher: Dispatcher = new Agent({
    connect: { lookup: guardedLookup(allowPrivate) as never, timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  const hostQueues = new Map<string, Promise<void>>();
  const lastRequestAt = new Map<string, number>();
  const robotsByOrigin = new Map<string, Promise<ReturnType<typeof robotsParser> | undefined>>();

  /** Requests to one host run one at a time with a gap between them. */
  function paced<T>(url: URL, task: () => Promise<T>): Promise<T> {
    const host = url.host;
    const isLocal = /(^|\.)localhost$/i.test(url.hostname) || isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""));
    const gap = isLocal ? localDelayMs : minDelayMs;

    const run = (hostQueues.get(host) ?? Promise.resolve()).then(async () => {
      const wait = (lastRequestAt.get(host) ?? -Infinity) + gap - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        lastRequestAt.set(host, Date.now());
      }
    });
    hostQueues.set(host, run.then(() => undefined, () => undefined));
    return run;
  }

  async function requestOnce(url: URL, accept: Accept): Promise<Exchange> {
    let response;
    try {
      response = await undiciFetch(url, {
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": USER_AGENT, Accept: ACCEPT_HEADER[accept] },
      });
    } catch (error) {
      return classifyFailure(url.href, error);
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) return { ok: false, url: url.href, reason: "http_error", status: response.status, detail: "Redirect without a Location header." };
      return { redirectTo: new URL(location, url).href };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const retryAfter = response.headers.get("retry-after") ?? "";
      return { ok: false, url: url.href, reason: "http_error", status: response.status, detail: `HTTP ${response.status}${retryAfter ? `; retry-after ${retryAfter}` : ""}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!ACCEPTED[accept].test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, url: url.href, reason: "unsupported_content_type", detail: contentType || "no content type" };
    }
    // Something that announces itself as enormous is not a page worth starting on.
    if (Number(response.headers.get("content-length")) > maxBytes * 4) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, url: url.href, reason: "too_large", detail: `More than ${maxBytes * 4} bytes.` };
    }

    // Modern marketing pages are often several megabytes of markup, with the words a person reads near the
    // top. So a long page is read up to the limit and used as far as it got, rather than thrown away.
    // Content-Length can be missing or wrong, which is why the limit is enforced while reading.
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for await (const chunk of response.body ?? []) {
        const room = maxBytes - received;
        if (chunk.byteLength >= room) {
          chunks.push(chunk.subarray(0, room));
          await response.body?.cancel().catch(() => undefined);
          break;
        }
        received += chunk.byteLength;
        chunks.push(chunk);
      }
    } catch (error) {
      return classifyFailure(url.href, error);
    }
    return { ok: true, url: url.href, status: response.status, contentType, body: Buffer.concat(chunks).toString("utf8") };
  }

  /** One URL, with backoff on the failures worth retrying: 429, 5xx, timeouts and network errors. */
  async function requestWithRetry(url: URL, accept: Accept): Promise<Exchange> {
    for (let attempt = 0; ; attempt++) {
      const result = await paced(url, () => requestOnce(url, accept));
      if ("redirectTo" in result || result.ok || attempt >= retries || !isRetryable(result)) return result;

      const retryAfterSeconds = Number(/retry-after (\d+)/.exec(result.detail)?.[1]);
      const backoff = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 500 * 2 ** attempt;
      await sleep(Math.min(backoff, 10_000));
    }
  }

  function robotsFor(url: URL) {
    const origin = url.origin;
    let cached = robotsByOrigin.get(origin);
    if (!cached) {
      const robotsUrl = new URL("/robots.txt", origin);
      cached = paced(robotsUrl, () => requestOnce(robotsUrl, "html")).then(
        // A missing or unreadable robots.txt means no restrictions were published.
        (result) => ("ok" in result && result.ok ? robotsParser(robotsUrl.href, result.body) : undefined),
      );
      robotsByOrigin.set(origin, cached);
    }
    return cached;
  }

  async function fetchPage(input: string, accept: Accept = "html"): Promise<FetchResult> {
    let current = input;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const checked = checkUrl(current, allowPrivate);
      if (!checked.ok) return { ok: false, url: current, reason: checked.reason, detail: checked.detail };

      const robots = await robotsFor(checked.url);
      if (robots && robots.isAllowed(checked.url.href, USER_AGENT) === false) {
        return { ok: false, url: checked.url.href, reason: "robots_disallowed", detail: "Disallowed by robots.txt." };
      }

      const result = await requestWithRetry(checked.url, accept);
      if (!("redirectTo" in result)) return result;

      // Every hop goes back through validation and robots.txt, so a redirect cannot smuggle in a private address.
      current = result.redirectTo;
    }
    return { ok: false, url: input, reason: "too_many_redirects", detail: `More than ${maxRedirects} redirects.` };
  }

  return { fetchPage, close: () => dispatcher.close() };
}

function isRetryable(result: Extract<FetchResult, { ok: false }>): boolean {
  if (result.reason === "timeout" || result.reason === "network") return true;
  return result.reason === "http_error" && (result.status === 429 || (result.status ?? 0) >= 500);
}

function classifyFailure(url: string, error: unknown): FetchResult {
  const chain: unknown[] = [];
  for (let current: unknown = error; current && chain.length < 5; current = (current as { cause?: unknown }).cause) chain.push(current);

  const blocked = chain.find((entry) => entry instanceof BlockedAddressError) as BlockedAddressError | undefined;
  if (blocked) return { ok: false, url, reason: "blocked_address", detail: blocked.message };

  const names = chain.map((entry) => `${(entry as Error).name ?? ""} ${(entry as { code?: string }).code ?? ""}`).join(" ");
  if (/Timeout|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|AbortError/i.test(names)) {
    return { ok: false, url, reason: "timeout", detail: "The site did not respond in time." };
  }
  const last = chain.at(-1) as Error | undefined;
  return { ok: false, url, reason: "network", detail: last?.message || "Network error." };
}
