import { ObjectId, type Filter, type UpdateFilter } from "mongodb";
import type { BuilderState } from "../builder/operations";
import type { Kit } from "../kit/schema";
import { validateKit } from "../kit/validate";
import type { Progress } from "../practice/leitner";
import type { RunTrace } from "../trace/trace";
import type { Database, KitDoc } from "./mongo";

export interface KitSummary {
  id: string;
  company: string;
  role: string;
  daysAvailable: number;
  requirementCount: number;
  questionCount: number;
  flashcardCount: number;
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredKit {
  id: string;
  kit: Kit;
  version: number;
  regeneration: (Omit<NonNullable<KitDoc["regeneration"]>, "startedAt"> & { startedAt: string }) | null;
  /** What "undo" would restore, if anything. */
  undoable: { section: "brief" } | { section: "questions"; category: string } | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * All access to kits goes through here, and every method takes the owner's id.
 * There is no way to load a kit by its id alone, so an ownership check cannot
 * be forgotten by a route.
 */
export function kitRepository(db: Database) {
  const owned = (userId: ObjectId, id: string): Filter<KitDoc> | undefined =>
    ObjectId.isValid(id) ? { _id: new ObjectId(id), userId } : undefined;

  return {
    async create(userId: ObjectId, kit: Kit, fingerprint: string, trace?: RunTrace): Promise<StoredKit> {
      const now = new Date();
      const doc: KitDoc = { _id: new ObjectId(), userId, kit, fingerprint, counters: highestIds(kit), version: 1, ...(trace ? { trace } : {}), createdAt: now, updatedAt: now };
      await db.kits.insertOne(doc);
      return toStored(doc);
    },

    async list(userId: ObjectId): Promise<KitSummary[]> {
      const docs = await db.kits.find({ userId }).sort({ updatedAt: -1 }).limit(200).toArray();
      return docs.map(toSummary);
    },

    async get(userId: ObjectId, id: string): Promise<StoredKit | undefined> {
      const filter = owned(userId, id);
      const doc = filter && (await db.kits.findOne(filter));
      return doc ? toStored(doc) : undefined;
    },

    /** Null for a kit made before runs were traced. */
    async trace(userId: ObjectId, id: string): Promise<{ trace: RunTrace | null } | undefined> {
      const filter = owned(userId, id);
      const doc = filter && (await db.kits.findOne(filter, { projection: { trace: 1 } }));
      return doc ? { trace: doc.trace ?? null } : undefined;
    },

    async practice(userId: ObjectId, id: string): Promise<{ kit: Kit; progress: Progress } | undefined> {
      const filter = owned(userId, id);
      const doc = filter && (await db.kits.findOne(filter));
      return doc ? { kit: doc.kit, progress: doc.practice ?? {} } : undefined;
    },

    async findByFingerprint(userId: ObjectId, fingerprint: string): Promise<StoredKit | undefined> {
      const doc = await db.kits.findOne({ userId, fingerprint }, { sort: { updatedAt: -1 } });
      return doc ? toStored(doc) : undefined;
    },

    /**
     * The only way a kit is changed. `change` is a pure function of the kit as stored right now;
     * the save succeeds only if nobody else saved in between, otherwise it is re-run on the newer kit.
     * So a background regeneration and a user's edit can never overwrite one another: whichever
     * lands second is applied on top of the first.
     */
    async mutate(userId: ObjectId, id: string, change: (doc: KitDoc) => KitChange): Promise<StoredKit | undefined> {
      const filter = owned(userId, id);
      if (!filter) return undefined;

      for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
        const doc = await db.kits.findOne(filter);
        if (!doc) return undefined;

        const { state = { kit: doc.kit, counters: doc.counters }, set = {}, unset = [] } = change(doc);
        const validation = validateKit(state.kit);
        if (!validation.ok) throw new Error(`Refusing to save an invalid kit: ${validation.issues.join("; ")}`);

        const update: UpdateFilter<KitDoc> = {
          $set: { ...set, kit: validation.kit, counters: state.counters, updatedAt: new Date() },
          $inc: { version: 1 },
          ...(unset.length > 0 ? { $unset: Object.fromEntries(unset.map((field) => [field, ""])) } : {}),
        };
        const saved = await db.kits.findOneAndUpdate({ ...filter, version: doc.version }, update, { returnDocument: "after" });
        if (saved) return toStored(saved);
      }
      throw new Error("The kit kept changing while it was being saved.");
    },

    /** Regenerations only live in this process; whatever a previous process left running is marked failed. */
    async failInterruptedRegenerations(): Promise<number> {
      const result = await db.kits.updateMany(
        { "regeneration.status": "running" },
        { $set: { "regeneration.status": "failed", "regeneration.error": "The server restarted while this section was being regenerated. Nothing was changed; try again." } },
      );
      return result.modifiedCount;
    },

    async remove(userId: ObjectId, id: string): Promise<boolean> {
      const filter = owned(userId, id);
      return filter ? (await db.kits.deleteOne(filter)).deletedCount === 1 : false;
    },
  };
}

export type KitRepository = ReturnType<typeof kitRepository>;

export interface KitChange {
  /** The new kit and counters. Omit to leave the kit itself untouched. */
  state?: BuilderState;
  set?: Partial<Pick<KitDoc, "regeneration" | "undo" | "practice">>;
  unset?: Array<"regeneration" | "undo" | "practice">;
}

const MAX_SAVE_ATTEMPTS = 6;

function highestIds(kit: Kit): KitDoc["counters"] {
  const highest = (ids: string[], prefix: string) => Math.max(0, ...ids.map((id) => Number(new RegExp(`^${prefix}(\\d+)$`).exec(id)?.[1] ?? 0)));
  return { q: highest(kit.questions.map((q) => q.id), "q"), f: highest(kit.flashcards.map((f) => f.id), "f") };
}

function toStored(doc: KitDoc): StoredKit {
  const { regeneration, undo } = doc;
  return {
    id: doc._id.toHexString(),
    kit: doc.kit,
    version: doc.version,
    regeneration: regeneration ? { ...regeneration, startedAt: regeneration.startedAt.toISOString() } : null,
    undoable: !undo ? null : undo.section === "brief" ? { section: "brief" } : { section: "questions", category: undo.category },
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toSummary(doc: KitDoc): KitSummary {
  const { kit } = doc;
  return {
    id: doc._id.toHexString(),
    company: kit.source.company,
    role: kit.source.role,
    daysAvailable: kit.schedule.days_available,
    requirementCount: kit.role.requirements.length,
    questionCount: kit.questions.length,
    flashcardCount: kit.flashcards.length,
    notes: kit.notes ?? [],
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
