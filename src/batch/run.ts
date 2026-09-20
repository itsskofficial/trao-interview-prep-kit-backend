import { createHash } from "node:crypto";
import { buildKit, type PipelineDeps } from "../pipeline/build-kit";
import { PipelineError } from "../pipeline/errors";
import type { RunTrace } from "../trace/trace";
import { CaseInputSchema, type BatchOutput, type CaseInput, type CaseResult } from "./schema";

export interface BatchDeps extends PipelineDeps {
  /** Cases run at once. The model client's shared limiter is what actually paces them. */
  concurrency?: number;
  /** A case still running after this long is recorded as TIMEOUT so the rest of the run is not held up. */
  caseTimeoutMs?: number;
  log?: (line: string) => void;
  /** Called as each case finishes, with everything finished so far in input order, so a run killed late still leaves a file. */
  onPartial?: (finished: CaseResult[]) => void | Promise<void>;
  /** Given each case's run trace. A case that timed out reports late, when its abandoned run notices; identical cases share one run and one trace. */
  onCaseTrace?: (id: string, trace: RunTrace) => void;
  /** How long to wait, once every case is decided, for abandoned runs to stop and hand over their traces. */
  abandonGraceMs?: number;
}

/** A case result before it is given its id, so identical cases can share one. */
type Outcome = CaseResult extends infer Result ? (Result extends CaseResult ? Omit<Result, "id"> : never) : never;

/**
 * Runs every case through the same pipeline the application uses. A case that
 * cannot produce a kit is recorded as failed and the run carries on. Results
 * come back in input order, one per case, whatever order they finished in.
 */
export async function runBatch(cases: unknown[], deps: BatchDeps): Promise<BatchOutput> {
  const { concurrency = 2, caseTimeoutMs = 170_000, log = () => undefined, now = () => new Date(), abandonGraceMs = 3_000 } = deps;
  const abandoned: Array<Promise<unknown>> = [];
  const results = new Array<CaseResult>(cases.length);
  const inFlight = new Map<string, Promise<Outcome>>();
  const traced = new Map<string, { ids: string[]; trace?: RunTrace }>();
  let next = 0;
  let finished = 0;

  async function worker(): Promise<void> {
    while (next < cases.length) {
      const index = next++;
      const entry = cases[index];
      const id = caseId(entry, index);
      const started = Date.now();

      const parsed = CaseInputSchema.safeParse(entry);
      let outcome: Outcome;
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => `${issue.path.join(".") || "case"}: ${issue.message}`).join("; ");
        outcome = failure(new PipelineError("INVALID_INPUT", message));
      } else {
        // The same description, company and days submitted twice is researched once.
        const key = fingerprint(parsed.data);
        const sharers = traced.get(key) ?? { ids: [] };
        traced.set(key, sharers);
        sharers.ids.push(id);
        if (sharers.trace) deps.onCaseTrace?.(id, sharers.trace);
        const onTrace = (trace: RunTrace) => {
          sharers.trace = trace;
          for (const sharer of sharers.ids) deps.onCaseTrace?.(sharer, trace);
        };
        const running = inFlight.get(key) ?? runCase(parsed.data, { ...deps, onTrace }, caseTimeoutMs, (work) => abandoned.push(work));
        inFlight.set(key, running);
        outcome = await running;
      }

      results[index] = { id, ...outcome } as CaseResult;
      await deps.onPartial?.(results.filter(Boolean));
      const label = outcome.status === "ok" ? "ok" : `failed (${outcome.error.code})`;
      log(`[${++finished}/${cases.length}] ${id}: ${label} in ${Math.round((Date.now() - started) / 1000)}s`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(cases.length, 1)) }, worker));

  // A run given up on stops at its next model call and then reports its trace. That is usually moments away,
  // but it is not waited for indefinitely: the results are decided, and a slow page fetch must not hold them.
  if (abandoned.length > 0) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(abandoned), new Promise((resolve) => (timer = setTimeout(resolve, abandonGraceMs)))]);
    clearTimeout(timer);
  }
  return { version: "1.0", generated_at: now().toISOString(), kits: results };
}

async function runCase(input: CaseInput, deps: BatchDeps, timeoutMs: number, onAbandoned: (work: Promise<unknown>) => void = () => undefined): Promise<Outcome> {
  let timer: NodeJS.Timeout | undefined;
  // Giving up on a case also stops it: its remaining model calls would otherwise sit in the shared
  // rate limiter ahead of the cases still running, and make them time out too.
  const abandoned = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandoned.abort();
      onAbandoned(work.catch(() => undefined));
      reject(new PipelineError("TIMEOUT", `No kit after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
  });

  let work: Promise<unknown> = Promise.resolve();
  try {
    const building = buildKit({ jd: input.jd, companyUrl: input.company_url, days: input.days }, { ...deps, signal: abandoned.signal });
    work = building;
    building.catch(() => undefined); // once abandoned, its eventual failure is nobody's concern
    const kit = await Promise.race([building, timeout]);
    return { status: "ok", kit, error: null };
  } catch (error) {
    return failure(error);
  } finally {
    clearTimeout(timer);
  }
}

function failure(error: unknown): Outcome {
  return {
    status: "failed",
    kit: null,
    error: {
      code: error instanceof PipelineError ? error.code : "INTERNAL",
      message: error instanceof Error && error.message ? error.message : "Unexpected error.",
    },
  };
}

function fingerprint(input: CaseInput): string {
  return createHash("sha256").update(JSON.stringify([input.jd.trim(), input.company_url.trim(), input.days])).digest("hex");
}

/** Results are keyed by the id we were given, even when the rest of the case is malformed. */
function caseId(entry: unknown, index: number): string {
  const id = (entry as { id?: unknown } | null)?.id;
  if (typeof id === "number") return String(id);
  return typeof id === "string" && id.length > 0 ? id : `case-${index + 1}`;
}
