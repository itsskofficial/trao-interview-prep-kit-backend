import type { LlmCallRecord } from "../llm/types";
import type { Accept, FetchResult, PageFetcher, SkipReason } from "../retrieval/fetcher";

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
  // A trace is a diagnostic, not a log of record: a run that somehow makes thousands of calls must not make a document too big to store.
  const keep = <T>(list: T[], entry: T) => {
    if (list.length < MAX_ENTRIES) list.push(entry);
  };

  const models = (): string[] => {
    const counts = new Map<string, number>();
    for (const call of llmCalls) if (call.outcome === "ok") counts.set(call.provider, (counts.get(call.provider) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([provider]) => provider);
  };

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
      keep(llmCalls, { ...record, atMs: Math.max(0, since() - record.latencyMs - record.queuedMs) });
    },

    fetch(record) {
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

      const sum = <T>(list: T[], pick: (entry: T) => number) => list.reduce((total, entry) => total + pick(entry), 0);
      const accepted = new Set<string>();
      let failovers = 0;
      for (const call of llmCalls) {
        // A step answered by a second provider after the first gave up is a failover.
        const key = call.step;
        if (call.outcome === "ok" && !accepted.has(key)) {
          accepted.add(key);
          if (llmCalls.some((earlier) => earlier.step === key && earlier.provider !== call.provider && earlier.atMs <= call.atMs && earlier.outcome !== "ok")) failovers++;
        }
      }

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
        totals: {
          llmCalls: llmCalls.length,
          llmMs: sum(llmCalls, (call) => call.latencyMs),
          queuedMs: sum(llmCalls, (call) => call.queuedMs),
          inputTokens: sum(llmCalls, (call) => call.usage?.inputTokens ?? 0),
          outputTokens: sum(llmCalls, (call) => call.usage?.outputTokens ?? 0),
          retries: llmCalls.filter((call) => call.attempt > 1).length,
          repairs: llmCalls.filter((call) => call.kind === "repair" && call.attempt === 1).length,
          failovers,
          fetches: fetches.length,
          fetchMs: sum(fetches, (fetch) => fetch.durationMs),
          pagesRead: fetches.filter((fetch) => fetch.outcome === "ok" && fetch.accept === "html").length,
          models: models(),
        },
      };
    },
  };
}

/** The same fetcher, with every fetch reported. The wrapped fetcher is shared between runs; the wrapper belongs to one. */
export function tracedFetcher(fetcher: PageFetcher, recorder: Pick<TraceRecorder, "fetch">, now: () => number = Date.now): PageFetcher {
  return {
    async fetchPage(url: string, accept: Accept = "html"): Promise<FetchResult> {
      const startedAt = now();
      const result = await fetcher.fetchPage(url, accept);
      recorder.fetch({
        url: withoutQuery(result.url || url),
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

/** Search APIs take the company name in the query string; a trace says which service was asked, not what for. */
function withoutQuery(url: string): string {
  const at = url.indexOf("?");
  return at === -1 ? url : `${url.slice(0, at)}?…`;
}
