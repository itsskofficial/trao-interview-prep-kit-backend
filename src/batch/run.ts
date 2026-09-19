import { buildKit, type PipelineDeps } from "../pipeline/build-kit";
import { PipelineError } from "../pipeline/errors";
import { CaseInputSchema, type BatchOutput, type CaseResult } from "./schema";

export interface BatchDeps extends PipelineDeps {
  log?: (line: string) => void;
}

/**
 * Runs every case through the same pipeline the application uses. A case that
 * cannot produce a kit is recorded as failed and the run carries on.
 */
export async function runBatch(cases: unknown[], deps: BatchDeps): Promise<BatchOutput> {
  const { log = () => undefined, now = () => new Date() } = deps;
  const results: CaseResult[] = [];

  for (const [index, entry] of cases.entries()) {
    const id = caseId(entry, index);
    const started = Date.now();
    const result = await runCase(id, entry, deps);
    results.push(result);
    const outcome = result.status === "ok" ? "ok" : `failed (${result.error.code})`;
    log(`[${index + 1}/${cases.length}] ${id}: ${outcome} in ${Math.round((Date.now() - started) / 1000)}s`);
  }

  return { version: "1.0", generated_at: now().toISOString(), kits: results };
}

async function runCase(id: string, entry: unknown, deps: BatchDeps): Promise<CaseResult> {
  const parsed = CaseInputSchema.safeParse(entry);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".") || "case"}: ${issue.message}`).join("; ");
    return failed(id, new PipelineError("INVALID_INPUT", message));
  }

  try {
    const { jd, company_url: companyUrl, days } = parsed.data;
    const kit = await buildKit({ jd, companyUrl, days }, deps);
    return { id, status: "ok", kit, error: null };
  } catch (error) {
    return failed(id, error);
  }
}

function failed(id: string, error: unknown): CaseResult {
  const known = error instanceof PipelineError;
  return {
    id,
    status: "failed",
    kit: null,
    error: {
      code: known ? error.code : "INTERNAL",
      message: error instanceof Error && error.message ? error.message : "Unexpected error.",
    },
  };
}

/** Results are keyed by the id we were given, even when the rest of the case is malformed. */
function caseId(entry: unknown, index: number): string {
  const id = (entry as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : `case-${index + 1}`;
}
