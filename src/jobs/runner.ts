import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import type { CaseError } from "../batch/schema";
import { kitRepository } from "../persistence/kits";
import type { Database, JobDoc } from "../persistence/mongo";
import { buildKit, type PipelineDeps, type PipelineInput, type ProgressEvent } from "../pipeline/build-kit";
import { PipelineError } from "../pipeline/errors";
import type { RunTrace } from "../trace/trace";

/** The same posting for the same company, however it was pasted. Days are not part of it: a new deadline is not a new kit. */
export function fingerprintOf(jd: string, companyUrl: string): string {
  const description = jd.toLowerCase().replace(/\s+/g, " ").trim();
  const url = companyUrl.trim().toLowerCase().replace(/\/+$/, "");
  return createHash("sha256").update(JSON.stringify([description, url])).digest("hex");
}

export interface JobRunner {
  /** Starts the job as soon as a slot is free. Returns immediately. */
  enqueue(jobId: ObjectId): void;
  /** Marks jobs left queued or running by a previous process as interrupted. They can then be retried. */
  recoverInterrupted(): Promise<number>;
  /** Resolves when nothing is queued or running. For tests and graceful shutdown. */
  idle(): Promise<void>;
}

/**
 * Runs generation in this process, a few jobs at a time. Generation is slow,
 * external and failure-prone, so the request that starts it returns at once
 * and everything the job does is written to its document, where the interface
 * polls for it. The job calls the same `buildKit` as the batch command.
 */
export function createJobRunner(db: Database, pipeline: PipelineDeps, concurrency = 2): JobRunner {
  const kits = kitRepository(db);
  const waiting: ObjectId[] = [];
  const running = new Set<Promise<void>>();

  function pump(): void {
    while (running.size < concurrency && waiting.length > 0) {
      const task = run(waiting.shift()!).finally(() => {
        running.delete(task);
        pump();
      });
      running.add(task);
    }
  }

  async function run(jobId: ObjectId): Promise<void> {
    const job = await db.jobs.findOneAndUpdate(
      { _id: jobId, status: "queued" },
      { $set: { status: "running", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!job) return; // already picked up, or cancelled

    const input: PipelineInput = job.input;
    // Progress writes are chained so steps are stored in the order they happened; independent writes can overtake each other.
    let progress: Promise<unknown> = Promise.resolve();
    const recordStep = (event: ProgressEvent) => {
      const step = { ...event, at: new Date() };
      progress = progress
        .then(() => db.jobs.updateOne({ _id: jobId }, { $push: { steps: step }, $set: { updatedAt: step.at } }))
        .catch(() => undefined); // losing a progress line must not fail the job
    };

    let trace: RunTrace | undefined;
    const onTrace = (finished: RunTrace) => {
      trace = finished;
    };

    try {
      const kit = await buildKit(input, { ...pipeline, onProgress: recordStep, onTrace });
      await progress;
      const stored = await kits.create(job.userId, kit, job.fingerprint, trace);
      await finish(jobId, { status: "succeeded", kitId: new ObjectId(stored.id), trace });
    } catch (error) {
      await progress;
      await finish(jobId, { status: "failed", error: toCaseError(error), trace });
    }
  }

  async function finish(jobId: ObjectId, fields: Pick<JobDoc, "status"> & Partial<Pick<JobDoc, "kitId" | "error" | "trace">>): Promise<void> {
    await db.jobs.updateOne({ _id: jobId }, { $set: { ...fields, updatedAt: new Date() }, $unset: { active: "" } });
  }

  return {
    enqueue(jobId) {
      waiting.push(jobId);
      pump();
    },

    async recoverInterrupted() {
      const result = await db.jobs.updateMany(
        { active: true },
        {
          $set: {
            status: "interrupted",
            error: { code: "INTERNAL", message: "The server restarted while this kit was being generated. Retry to run it again." },
            updatedAt: new Date(),
          },
          $unset: { active: "" },
        },
      );
      return result.modifiedCount;
    },

    async idle() {
      while (running.size > 0 || waiting.length > 0) await Promise.all(running);
    },
  };
}

function toCaseError(error: unknown): CaseError {
  if (error instanceof PipelineError) return { code: error.code, message: error.message };
  console.error(error);
  return { code: "INTERNAL", message: "Something went wrong while generating this kit." };
}
