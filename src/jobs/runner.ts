import { createHash, randomUUID } from "node:crypto";
import { ObjectId, type Filter } from "mongodb";
import type { CaseError } from "../batch/schema";
import { silentLogger, type Logger } from "../logging/logger";
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
  /** Says there is work. The job is already in the database, which is the queue; this only saves waiting for the next poll. */
  enqueue(jobId: ObjectId): void;
  /** Starts polling for work, and closes jobs that have used up their attempts. Returns how many were closed. */
  start(): Promise<number>;
  /** Stops taking work and hands running jobs back to the queue, for another process to pick up at once. */
  release(): Promise<void>;
  /** Resolves when nothing is claimable or running. For tests and graceful shutdown. */
  idle(): Promise<void>;
}

export interface JobRunnerOptions {
  concurrency?: number;
  logger?: Logger;
  /** How long a claim lasts without being renewed. A process that dies stops renewing, and its jobs become claimable after this. */
  leaseMs?: number;
  /** How often to look for work nobody announced: jobs queued by another process, and leases that ran out. */
  pollMs?: number;
  /** Runs of one job, counting the first. A job that keeps killing its process must not be retried for ever. */
  maxAttempts?: number;
  now?: () => Date;
}

const INTERRUPTED: CaseError = { code: "INTERNAL", message: "The server stopped more than once while this kit was being generated. Retry to run it again." };

/**
 * Generation is slow, external and failure-prone, so the request that starts it returns at once and the
 * job runs here. The jobs collection is the queue, which is what lets a job outlive this process:
 *
 * - A job is claimed with one atomic update that sets a lease. Two processes cannot claim the same job.
 * - The lease is renewed while the job runs. A process that dies stops renewing; when the lease runs out
 *   the job is claimable again and starts over, up to `maxAttempts`. Queued jobs simply wait.
 * - A process told to stop (a redeploy) hands its jobs back at once rather than letting leases run out.
 * - A process that finds it has lost its lease stops working and writes nothing: the job is someone else's now.
 *
 * Everything a job does is written to its document, where the interface polls for it. The job calls the
 * same `buildKit` as the batch command.
 */
export function createJobRunner(db: Database, pipeline: PipelineDeps, options: JobRunnerOptions = {}): JobRunner {
  const { concurrency = 2, logger = silentLogger, leaseMs = 45_000, pollMs = 5_000, maxAttempts = 2, now = () => new Date() } = options;
  const kits = kitRepository(db);
  const owner = randomUUID();
  const running = new Map<string, { task: Promise<void>; stop: AbortController }>();
  let pumping: Promise<void> = Promise.resolve();
  let poll: NodeJS.Timeout | undefined;
  let accepting = true;

  const claimable = (): Filter<JobDoc> => ({
    active: true,
    attempts: { $lt: maxAttempts },
    $or: [{ status: "queued" }, { status: "running", "lease.expiresAt": { $lt: now() } }],
  });

  /** Oldest first. The update is the claim: the process whose update matches has the job, and no other update can. */
  async function claim(): Promise<JobDoc | null> {
    const at = now();
    return db.jobs.findOneAndUpdate(
      claimable(),
      // A job taken over from a dead process starts again, so what that process recorded is cleared.
      { $set: { status: "running", lease: { owner, expiresAt: new Date(at.getTime() + leaseMs) }, steps: [], updatedAt: at }, $inc: { attempts: 1 }, $unset: { trace: "", error: "" } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
  }

  /** One at a time, so two nudges cannot both see a free slot and overfill it. */
  function pump(): Promise<void> {
    pumping = pumping.then(async () => {
      while (accepting && running.size < concurrency) {
        const job = await claim().catch((error: unknown) => {
          logger.error({ err: error }, "could not claim a job");
          return null;
        });
        if (!job) return;
        const stop = new AbortController();
        const id = job._id.toHexString();
        const task = run(job, stop.signal).finally(() => {
          running.delete(id);
          void pump();
        });
        running.set(id, { task, stop });
      }
    });
    return pumping;
  }

  const mine = (jobId: ObjectId): Filter<JobDoc> => ({ _id: jobId, "lease.owner": owner });

  async function run(job: JobDoc, stopped: AbortSignal): Promise<void> {
    const jobId = job._id;
    const log = logger.child({ jobId: jobId.toHexString(), userId: job.userId.toHexString() });
    log.info({ days: job.input.days, attempt: job.attempts }, (job.attempts ?? 1) > 1 ? "job resumed" : "job started");
    const input: PipelineInput = job.input;

    // Renewed well inside the lease. If the renewal finds the lease is no longer ours, the run is stopped.
    const lost = new AbortController();
    const heartbeat = setInterval(() => {
      void db.jobs
        .updateOne(mine(jobId), { $set: { "lease.expiresAt": new Date(now().getTime() + leaseMs) } })
        .then((result) => {
          if (result.matchedCount === 0) lost.abort();
        })
        .catch(() => undefined); // one missed renewal is not a lost lease; the next one may get through
    }, Math.max(50, Math.floor(leaseMs / 3)));
    heartbeat.unref();

    // Progress writes are chained so steps are stored in the order they happened; independent writes can overtake each other.
    let progress: Promise<unknown> = Promise.resolve();
    const recordStep = (event: ProgressEvent) => {
      const step = { ...event, at: now() };
      if (event.status === "failed") log.warn({ step: event.step, detail: event.detail }, "step failed");
      else log.debug({ step: event.step, status: event.status, detail: event.detail }, "step");
      progress = progress
        .then(() => db.jobs.updateOne(mine(jobId), { $push: { steps: step }, $set: { updatedAt: step.at } }))
        .catch(() => undefined); // losing a progress line must not fail the job
    };

    let trace: RunTrace | undefined;
    const signal = AbortSignal.any([stopped, lost.signal, ...(pipeline.signal ? [pipeline.signal] : [])]);
    try {
      const kit = await buildKit(input, { ...pipeline, signal, onProgress: recordStep, onTrace: (finished) => (trace = finished) });
      await progress;
      // The kit is stored only by the process that still holds the job, so a job taken over elsewhere cannot produce two kits.
      if (signal.aborted || !(await db.jobs.findOne(mine(jobId), { projection: { _id: 1 } }))) return void log.warn("job finished after losing its lease; result discarded");
      const stored = await kits.create(job.userId, kit, job.fingerprint, trace);
      await finish(jobId, { status: "succeeded", kitId: new ObjectId(stored.id), trace });
      log.info({ kitId: stored.id, ms: trace?.durationMs, ...trace?.totals }, "job succeeded");
    } catch (error) {
      await progress;
      // Stopped on purpose, or taken over: the job has not failed, it is back in the queue or running elsewhere.
      if (signal.aborted) return void log.info({ handedBack: stopped.aborted }, "job stopped before it finished");
      const failure = toCaseError(error);
      await finish(jobId, { status: "failed", error: failure, trace });
      // A pipeline error is an expected way to fail and is already described; anything else is a bug and gets its stack.
      if (error instanceof PipelineError) log.warn({ code: failure.code, reason: failure.message, ms: trace?.durationMs, ...trace?.totals }, "job failed");
      else log.error({ err: error, ms: trace?.durationMs }, "job crashed");
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function finish(jobId: ObjectId, fields: Pick<JobDoc, "status"> & Partial<Pick<JobDoc, "kitId" | "error" | "trace">>): Promise<void> {
    await db.jobs.updateOne(mine(jobId), { $set: { ...fields, updatedAt: now() }, $unset: { active: "", lease: "" } });
  }

  /** Jobs whose process died on every attempt. They are closed, and the user can retry them by hand. */
  async function closeExhausted(): Promise<number> {
    const result = await db.jobs.updateMany(
      { active: true, attempts: { $gte: maxAttempts }, $or: [{ status: "queued" }, { status: "running", "lease.expiresAt": { $lt: now() } }] },
      { $set: { status: "interrupted", error: INTERRUPTED, updatedAt: now() }, $unset: { active: "", lease: "" } },
    );
    return result.modifiedCount;
  }

  return {
    enqueue() {
      void pump();
    },

    async start() {
      // Jobs written before attempts were counted have no count to compare; they have had none.
      await db.jobs.updateMany({ active: true, attempts: { $exists: false } }, { $set: { attempts: 0 } });
      // A job the previous version of this runner was in the middle of has no lease to lapse, so nothing would ever
      // reclaim it or close it: it would sit in "running", hold one of its owner's slots and block the same posting from
      // being submitted again. It is put back in the queue, and the attempt cap applies to it from here like any other.
      await db.jobs.updateMany({ active: true, status: "running", lease: { $exists: false } }, { $set: { status: "queued", steps: [], updatedAt: now() } });
      const closed = await closeExhausted();
      poll = setInterval(() => {
        void closeExhausted().catch(() => undefined);
        void pump();
      }, pollMs);
      poll.unref();
      await pump();
      return closed;
    },

    async release() {
      accepting = false;
      if (poll) clearInterval(poll);
      await pumping;
      const held = [...running.values()];
      for (const { stop } of held) stop.abort();
      // Back in the queue with the attempt given back: being redeployed is not the job's fault.
      await db.jobs.updateMany({ "lease.owner": owner, status: "running" }, { $set: { status: "queued", steps: [], updatedAt: now() }, $unset: { lease: "" }, $inc: { attempts: -1 } });
      await Promise.allSettled(held.map(({ task }) => task));
    },

    async idle() {
      for (;;) {
        await pump();
        if (running.size > 0) await Promise.allSettled([...running.values()].map(({ task }) => task));
        else if (!accepting || (await db.jobs.countDocuments(claimable())) === 0) return;
      }
    },
  };
}

function toCaseError(error: unknown): CaseError {
  if (error instanceof PipelineError) return { code: error.code, message: error.message };
  return { code: "INTERNAL", message: "Something went wrong while generating this kit." };
}
