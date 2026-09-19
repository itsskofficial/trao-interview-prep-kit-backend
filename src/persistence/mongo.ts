import { MongoClient, type Collection, type ObjectId } from "mongodb";
import type { CaseError } from "../batch/schema";
import type { Kit } from "../kit/schema";
import type { ProgressEvent } from "../pipeline/build-kit";

export interface UserDoc {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface KitDoc {
  _id: ObjectId;
  /** Every query on this collection is scoped by this field. */
  userId: ObjectId;
  kit: Kit;
  /** Hash of the normalised description and company URL, for spotting a duplicate submission. */
  fingerprint: string;
  /** Highest number ever used for each id prefix, so an id is never reused after a delete. */
  counters: { q: number; f: number };
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
  kitId?: ObjectId;
  /** Jobs created by one file upload share this. */
  batchId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Database {
  users: Collection<UserDoc>;
  kits: Collection<KitDoc>;
  jobs: Collection<JobDoc>;
  close(): Promise<void>;
}

export async function connectDatabase(uri: string, name: string): Promise<Database> {
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 8_000 });
  const db = client.db(name);
  const database: Database = {
    users: db.collection<UserDoc>("users"),
    kits: db.collection<KitDoc>("kits"),
    jobs: db.collection<JobDoc>("jobs"),
    close: () => client.close(),
  };

  await Promise.all([
    database.users.createIndex({ email: 1 }, { unique: true }),
    database.kits.createIndex({ userId: 1, updatedAt: -1 }),
    database.kits.createIndex({ userId: 1, fingerprint: 1 }),
    database.jobs.createIndex({ userId: 1, createdAt: -1 }),
    database.jobs.createIndex({ userId: 1, fingerprint: 1 }, { unique: true, partialFilterExpression: { active: true } }),
  ]);
  return database;
}
