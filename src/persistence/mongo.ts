import { MongoClient, type Collection, type ObjectId } from "mongodb";
import type { CaseError } from "../batch/schema";
import type { Kit, Question, QuestionCategory } from "../kit/schema";
import type { ProgressEvent } from "../pipeline/build-kit";
import type { Progress } from "../practice/leitner";
import type { RunTrace } from "../trace/trace";

export interface UserDoc {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export type RegenerationTarget = { section: "brief" } | { section: "questions"; category: QuestionCategory };

/** What the last regeneration replaced, kept so it can be put back. Only the most recent one is kept. */
export type UndoSnapshot =
  | { section: "questions"; category: QuestionCategory; removed: Question[]; addedIds: string[]; at: Date }
  | { section: "brief"; previous: Pick<Kit, "company_brief" | "hiring_stages" | "interview_insights">; at: Date };

export interface KitDoc {
  _id: ObjectId;
  /** Every query on this collection is scoped by this field. */
  userId: ObjectId;
  kit: Kit;
  /** Hash of the normalised description and company URL, for spotting a duplicate submission. */
  fingerprint: string;
  /** Highest number ever used for each id prefix, so an id is never reused after a delete. */
  counters: { q: number; f: number };
  /** Goes up by one on every save. A save only succeeds against the version it read, so two writers cannot overwrite each other. */
  version: number;
  /** Present while a section is being regenerated, or after one failed. */
  regeneration?: RegenerationTarget & { status: "running" | "failed"; startedAt: Date; error?: string };
  undo?: UndoSnapshot;
  /** Practice state per flashcard id. Kept beside the kit, not in it: it is the user's progress, not part of the kit's content. */
  practice?: Progress;
  /** What the run that produced this kit did. Beside the kit, not in it: it describes the making, not the kit. */
  trace?: RunTrace;
  createdAt: Date;
  updatedAt: Date;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted";

export interface JobDoc {
  _id: ObjectId;
  userId: ObjectId;
  fingerprint: string;
  input: { jd: string; companyUrl: string; days: number };
  /** Shown in lists before a kit exists: the first line of the description. */
  label: string;
  status: JobStatus;
  /** True while queued or running. A unique index on it is what stops the same posting being generated twice at once. */
  active?: true;
  steps: Array<ProgressEvent & { at: Date }>;
  error?: CaseError;
  /** Kept for failed runs too, which is when it is most wanted. */
  trace?: RunTrace;
  kitId?: ObjectId;
  /** Jobs created by one file upload share this. */
  batchId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UsageDoc {
  _id: ObjectId;
  userId: ObjectId;
  kind: "generation" | "regeneration";
  at: Date;
}

export interface Database {
  users: Collection<UserDoc>;
  kits: Collection<KitDoc>;
  jobs: Collection<JobDoc>;
  usage: Collection<UsageDoc>;
  close(): Promise<void>;
}

export async function connectDatabase(uri: string, name: string): Promise<Database> {
  const client = await MongoClient.connect(uri, {
    serverSelectionTimeoutMS: 8_000,
    // Without this an optional field set to `undefined` is stored as `null`, and a kit read back would fail its own schema.
    ignoreUndefined: true,
  });
  const db = client.db(name);
  const database: Database = {
    users: db.collection<UserDoc>("users"),
    kits: db.collection<KitDoc>("kits"),
    jobs: db.collection<JobDoc>("jobs"),
    usage: db.collection<UsageDoc>("usage"),
    close: () => client.close(),
  };

  await Promise.all([
    database.users.createIndex({ email: 1 }, { unique: true }),
    database.kits.createIndex({ userId: 1, updatedAt: -1 }),
    database.kits.createIndex({ userId: 1, fingerprint: 1 }),
    database.jobs.createIndex({ userId: 1, createdAt: -1 }),
    database.usage.createIndex({ userId: 1, at: -1 }),
    database.usage.createIndex({ at: 1 }, { expireAfterSeconds: 2 * 60 * 60 }),
    database.jobs.createIndex({ userId: 1, fingerprint: 1 }, { unique: true, partialFilterExpression: { active: true } }),
  ]);
  return database;
}
