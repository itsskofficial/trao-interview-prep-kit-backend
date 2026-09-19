import { randomUUID } from "node:crypto";
import { Router } from "express";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { MAX_DAYS } from "../batch/schema";
import { fingerprintOf, type JobRunner } from "../jobs/runner";
import type { KitRepository } from "../persistence/kits";
import type { Database, JobDoc } from "../persistence/mongo";
import { ApiError, parse } from "./errors";
import type { UsageLimiter } from "./limits";

const MAX_BATCH = 10;

const httpUrl = z
  .string()
  .trim()
  .max(2_000)
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Enter a full web address, starting with http:// or https://");

const NewJobSchema = z.object({
  jd: z.string().trim().min(1, "Paste the job description.").max(50_000, "The description is too long (50,000 characters at most)."),
  company_url: httpUrl,
  days: z.number().int("Days must be a whole number.").min(1, "At least 1 day.").max(MAX_DAYS, `At most ${MAX_DAYS} days.`),
  /** Generate again even though a kit for this posting already exists. */
  fresh: z.boolean().optional(),
});

const BatchSchema = z.object({
  cases: z.array(z.unknown()).min(1, "The file has no cases.").max(MAX_BATCH, `Upload at most ${MAX_BATCH} cases at a time.`),
  fresh: z.boolean().optional(),
});

function toPublic(job: JobDoc) {
  return {
    id: job._id.toHexString(),
    label: job.label,
    status: job.status,
    days: job.input.days,
    companyUrl: job.input.companyUrl,
    steps: job.steps.map(({ at, ...step }) => ({ ...step, at: at.toISOString() })),
    error: job.error ?? null,
    kitId: job.kitId?.toHexString() ?? null,
    batchId: job.batchId ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

type StartResult =
  | { outcome: "started"; job: JobDoc }
  | { outcome: "already_running"; job: JobDoc }
  | { outcome: "kit_exists"; kitId: string };

/** Mounted behind requireAuth. */
export function jobsRouter(db: Database, kits: KitRepository, runner: JobRunner, limits: UsageLimiter, maxActiveJobs: number): Router {
  const router = Router();
  const userId = (locals: Record<string, unknown>) => locals.userId as ObjectId;

  async function start(owner: ObjectId, input: z.infer<typeof NewJobSchema>, batchId?: string): Promise<StartResult> {
    const fingerprint = fingerprintOf(input.jd, input.company_url);

    const running = await db.jobs.findOne({ userId: owner, fingerprint, active: true });
    if (running) return { outcome: "already_running", job: running };

    if (!input.fresh) {
      const existing = await kits.findByFingerprint(owner, fingerprint);
      if (existing) return { outcome: "kit_exists", kitId: existing.id };
    }

    // Only a job that will really run is charged for: duplicates and existing kits cost nothing.
    if ((await db.jobs.countDocuments({ userId: owner, active: true })) >= maxActiveJobs) {
      throw new ApiError(429, "TOO_MANY_ACTIVE_JOBS", `You already have ${maxActiveJobs} kits being generated. Wait for one to finish.`);
    }
    const charge = await limits.spend(owner, "generation");

    const now = new Date();
    const job: JobDoc = {
      _id: new ObjectId(),
      userId: owner,
      fingerprint,
      input: { jd: input.jd, companyUrl: input.company_url, days: input.days },
      label: input.jd.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 120) ?? "Untitled role",
      status: "queued",
      active: true,
      steps: [],
      ...(batchId ? { batchId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.jobs.insertOne(job);
    } catch (error) {
      // This job will not run, so it is not paid for.
      await charge.refund();
      // Two submissions raced past the check above; the unique index let only one in.
      if ((error as { code?: number }).code !== 11000) throw error;
      const winner = await db.jobs.findOne({ userId: owner, fingerprint, active: true });
      if (winner) return { outcome: "already_running", job: winner };
      throw error;
    }
    runner.enqueue(job._id);
    return { outcome: "started", job };
  }

  const respond = (result: StartResult) =>
    result.outcome === "kit_exists" ? { outcome: result.outcome, kitId: result.kitId } : { outcome: result.outcome, job: toPublic(result.job) };

  router.post("/", async (request, response) => {
    const result = await start(userId(response.locals), parse(NewJobSchema, request.body));
    response.status(result.outcome === "started" ? 202 : 200).json(respond(result));
  });

  router.post("/batch", async (request, response) => {
    const { cases, fresh } = parse(BatchSchema, request.body);
    const batchId = randomUUID();
    const results = [];
    // One bad entry is reported beside the others; it does not reject the file.
    for (const [index, entry] of cases.entries()) {
      const parsed = NewJobSchema.safeParse({ ...(entry as object), fresh });
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({ field: issue.path.join(".") || "(case)", message: issue.message }));
        results.push({ index, outcome: "invalid" as const, issues });
        continue;
      }
      try {
        results.push({ index, ...respond(await start(userId(response.locals), parsed.data, batchId)) });
      } catch (error) {
        // Over the allowance part-way through a file: the rest are reported, not silently dropped.
        if (!(error instanceof ApiError) || error.status !== 429) throw error;
        results.push({ index, outcome: "limited" as const, message: error.message });
      }
    }
    response.status(202).json({ batchId, results });
  });

  router.get("/", async (_request, response) => {
    const jobs = await db.jobs.find({ userId: userId(response.locals) }).sort({ createdAt: -1 }).limit(50).toArray();
    response.json({ jobs: jobs.map(toPublic) });
  });

  router.get("/:id", async (request, response) => {
    response.json({ job: toPublic(await owned(db, userId(response.locals), request.params.id)) });
  });

  router.post("/:id/retry", async (request, response) => {
    const owner = userId(response.locals);
    const job = await owned(db, owner, request.params.id);
    if (job.status !== "failed" && job.status !== "interrupted") {
      throw new ApiError(409, "NOT_RETRYABLE", "Only a failed or interrupted job can be retried.");
    }
    // A retry calls the model again, so it counts like a new generation.
    if ((await db.jobs.countDocuments({ userId: owner, active: true })) >= maxActiveJobs) {
      throw new ApiError(429, "TOO_MANY_ACTIVE_JOBS", `You already have ${maxActiveJobs} kits being generated. Wait for one to finish.`);
    }
    const charge = await limits.spend(owner, "generation");
    const retried = await db.jobs
      .findOneAndUpdate(
        { _id: job._id, userId: owner, status: job.status },
        { $set: { status: "queued", active: true, steps: [], updatedAt: new Date() }, $unset: { error: "" } },
        { returnDocument: "after" },
      )
      .catch(async (error: unknown) => {
        await charge.refund();
        if ((error as { code?: number }).code === 11000) throw new ApiError(409, "ALREADY_RUNNING", "This posting is already being generated.");
        throw error;
      });
    if (!retried) {
      await charge.refund();
      throw new ApiError(409, "NOT_RETRYABLE", "This job was already retried.");
    }
    runner.enqueue(retried._id);
    response.status(202).json({ job: toPublic(retried) });
  });

  return router;
}

async function owned(db: Database, userId: ObjectId, id: string): Promise<JobDoc> {
  const job = ObjectId.isValid(id) ? await db.jobs.findOne({ _id: new ObjectId(id), userId }) : null;
  if (!job) throw ApiError.notFound("Job");
  return job;
}
