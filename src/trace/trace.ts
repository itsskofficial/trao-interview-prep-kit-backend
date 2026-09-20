import type { LlmCallRecord } from "../llm/types";
import type { Accept, FetchOptions, FetchResult, PageFetcher, SkipReason } from "../retrieval/fetcher";

/**
 * Everything one run of the pipeline did, in the order it did it: steps with
 * how long each took, every call to a model and every page fetched. It holds
 * no prompt, no answer and no page body, so it is safe to store and to show.
 *
 * It is kept in the application rather than sent to a tracing service because
 * a clean clone has no account with one, and a trace nobody can see is no use.
 */
export interface RunTrace {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: "ok" | "failed";
  /** Why the run failed, when it did. */
  error?: string;
  steps: StepTrace[];
  llmCalls: LlmCallTrace[];
  fetches: FetchTrace[];
  /** What code decided along the way that is not a step, a call or a fetch, e.g. "2 duplicate questions merged". */
  decisions: DecisionTrace[];
  totals: TraceTotals;
}

export interface StepTrace {
  step: string;
  status: "done" | "skipped" | "failed" | "unfinished";
  detail?: string;
  /** Milliseconds after the run started. */
  atMs: number;
  durationMs: number;
}

export interface LlmCallTrace extends LlmCallRecord {
  atMs: number;
}

export interface FetchTrace {
  url: string;
  accept: Accept;
  outcome: "ok" | SkipReason;
  status?: number;
  /** Includes the polite wait before a second request to the same host. */
  durationMs: number;
  chars: number;
  atMs: number;
}

export interface DecisionTrace {
  step: string;
  what: string;
  atMs: number;
}

export interface TraceTotals {
  llmCalls: number;
  llmMs: number;
  queuedMs: number;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  repairs: number;
  failovers: number;
  fetches: number;
  fetchMs: number;
  pagesRead: number;
  /** Providers that produced an accepted answer, most used first. */
  models: string[];
}

export interface StepEvent {
  step: string;
  status: "started" | "done" | "skipped" | "failed";
  detail?: string;
}

export interface TraceRecorder {
  step(event: StepEvent): void;
  llmCall(record: LlmCallRecord): void;
  fetch(record: Omit<FetchTrace, "atMs">): void;
  decision(step: string, what: string): void;
  /** Providers that have produced an accepted answer so far. */
  models(): string[];
  finish(outcome: "ok" | "failed", error?: string): RunTrace;
}

const MAX_ENTRIES = 500;

export function createTraceRecorder(now: () => number = Date.now): TraceRecorder {
  const startedAt = now();
  const since = () => now() - startedAt;
  const steps: StepTrace[] = [];
  const open = new Map<string, number>();
  const llmCalls: LlmCallTrace[] = [];
  const fetches: FetchTrace[] = [];
  const decisions: DecisionTrace[] = [];
  // A trace is a diagnostic, not a log of record: a run that somehow makes thousands of calls must not make a document too big
  // to store. The detail stops growing; the totals below are counted as things happen, so they stay true whatever was kept.
  const keep = <T>(list: T[], entry: T) => {
    if (list.length < MAX_ENTRIES) list.push(entry);
  };
  const totals = { llmCalls: 0, llmMs: 0, queuedMs: 0, inputTokens: 0, outputTokens: 0, retries: 0, repairs: 0, failovers: 0, fetches: 0, fetchMs: 0, pagesRead: 0 };
  const answered = new Map<string, number>();
  /** Per step: which providers failed before one answered, to count failovers. */
  const failedOn = new Map<string, Set<string>>();

  const models = (): string[] => [...answered.entries()].sort((a, b) => b[1] - a[1]).map(([provider]) => provider);

  return {
    step(event) {
      if (event.status === "started") {
        open.set(event.step, since());
        return;
      }
      const atMs = open.get(event.step) ?? since();
      open.delete(event.step);
      keep(steps, { step: event.step, status: event.status, ...(event.detail ? { detail: event.detail } : {}), atMs, durationMs: since() - atMs });
    },

    llmCall(record) {
      totals.llmCalls++;
      totals.llmMs += record.latencyMs;
      totals.queuedMs += record.queuedMs;
      totals.inputTokens += record.usage?.inputTokens ?? 0;
      totals.outputTokens += record.usage?.outputTokens ?? 0;
      if (record.attempt > 1) totals.retries++;
      if (record.kind === "repair" && record.attempt === 1) totals.repairs++;

      const failed = failedOn.get(record.step) ?? new Set<string>();
      failedOn.set(record.step, failed);
      if (record.outcome === "ok") {
        answered.set(record.provider, (answered.get(record.provider) ?? 0) + 1);
        // Answered by one provider after another gave up on the same step.
        if ([...failed].some((provider) => provider !== record.provider)) totals.failovers++;
        failed.clear();
      } else if (record.outcome !== "invalid_output") {
        failed.add(record.provider);
      }
      keep(llmCalls, { ...record, atMs: Math.max(0, since() - record.latencyMs - record.queuedMs) });
    },

    fetch(record) {
      totals.fetches++;
      totals.fetchMs += record.durationMs;
      if (record.outcome === "ok" && record.accept === "html") totals.pagesRead++;
      keep(fetches, { ...record, atMs: Math.max(0, since() - record.durationMs) });
    },

    decision(step, what) {
      keep(decisions, { step, what, atMs: since() });
    },

    models,

    finish(outcome, error) {
      // A step that started and never reported back is where a failed run stopped.
      for (const [step, atMs] of open) steps.push({ step, status: "unfinished", atMs, durationMs: since() - atMs });
      open.clear();

      return {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(now()).toISOString(),
        durationMs: since(),
        outcome,
        ...(error ? { error } : {}),
        steps,
        llmCalls,
        fetches,
        decisions,
        totals: { ...totals, models: models() },
      };
    },
  };
}

/** The same fetcher, with every fetch reported. The wrapped fetcher is shared between runs; the wrapper belongs to one. */
export function tracedFetcher(fetcher: PageFetcher, recorder: Pick<TraceRecorder, "fetch">, now: () => number = Date.now): PageFetcher {
  return {
    // Headers are passed through and never recorded: that is where a search key travels.
    async fetchPage(url: string, accept: Accept = "html", options?: FetchOptions): Promise<FetchResult> {
      const startedAt = now();
      // The fetcher's contract is never to throw. Should it ever, the run still learns that a fetch was tried and failed.
      const result = await fetcher.fetchPage(url, accept, options).catch((error: unknown) => {
        recorder.fetch({ url: safeAddress(url), accept, outcome: "network", durationMs: now() - startedAt, chars: 0 });
        throw error;
      });
      recorder.fetch({
        url: safeAddress(result.url || url),
        accept,
        outcome: result.ok ? "ok" : result.reason,
        ...(result.status !== undefined ? { status: result.status } : {}),
        durationMs: now() - startedAt,
        chars: result.ok ? result.body.length : 0,
      });
      return result;
    },
    // Closing is the owner's business, not a single run's.
    close: async () => undefined,
  };
}

/**
 * Where a fetch went, as far as a stored trace should say: origin and path. The path stays because which
 * page was read is the point of the trace, and the same addresses are already in the kit's research log.
 * Credentials, the query string (search APIs carry the company name there) and the fragment do not.
 */
export function safeAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search ? "?…" : ""}`;
  } catch {
    return "[unparseable address]";
  }
}
