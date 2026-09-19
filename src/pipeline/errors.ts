import type { CaseErrorCode } from "../batch/schema";

/** The only error type that leaves the pipeline: a fixed code plus a message fit to show a user. */
export class PipelineError extends Error {
  constructor(
    readonly code: CaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}
