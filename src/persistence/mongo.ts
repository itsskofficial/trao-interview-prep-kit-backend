import { MongoClient, type Collection, type ObjectId } from "mongodb";
import type { Kit } from "../kit/schema";

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

export interface Database {
  users: Collection<UserDoc>;
  kits: Collection<KitDoc>;
  close(): Promise<void>;
}

export async function connectDatabase(uri: string, name: string): Promise<Database> {
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 8_000 });
  const db = client.db(name);
  const database: Database = {
    users: db.collection<UserDoc>("users"),
    kits: db.collection<KitDoc>("kits"),
    close: () => client.close(),
  };

  await Promise.all([
    database.users.createIndex({ email: 1 }, { unique: true }),
    database.kits.createIndex({ userId: 1, updatedAt: -1 }),
    database.kits.createIndex({ userId: 1, fingerprint: 1 }),
  ]);
  return database;
}
