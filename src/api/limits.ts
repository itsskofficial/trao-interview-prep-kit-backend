import { ObjectId } from "mongodb";
import type { Config } from "../config";
import type { Database } from "../persistence/mongo";
import { ApiError } from "./errors";

const HOUR_MS = 60 * 60 * 1000;

/** A charge that can be given back if the work it paid for never started. */
export interface Charge {
  refund(): Promise<void>;
}

export interface UsageLimiter {
  /** Charges this user for one model-spending action, or refuses with a 429 if that would pass the hourly allowance. */
  spend(userId: ObjectId, kind: "generation" | "regeneration"): Promise<Charge>;
}

/**
 * The deployed app is public, and every kit or regeneration spends requests from a free-tier
 * quota shared by everyone. One account cannot use it all: each gets an hourly allowance.
 *
 * The charge is written first and counted second. Counting first would let thirty requests sent
 * at the same instant all see room and all proceed; this way the ones that push the total over
 * the allowance see it, take their own entry back, and are refused. Entries expire on their own
 * through a TTL index.
 */
export function createUsageLimiter(db: Database, config: Config): UsageLimiter {
  return {
    async spend(userId, kind) {
      const _id = new ObjectId();
      await db.usage.insertOne({ _id, userId, kind, at: new Date() });
      const refund = async () => void (await db.usage.deleteOne({ _id }));

      const since = new Date(Date.now() - HOUR_MS);
      const used = await db.usage.countDocuments({ userId, at: { $gte: since } });
      if (used <= config.GENERATIONS_PER_HOUR) return { refund };

      await refund();
      const oldest = await db.usage.findOne({ userId, at: { $gte: since } }, { sort: { at: 1 } });
      const minutes = oldest ? Math.max(1, Math.ceil((oldest.at.getTime() + HOUR_MS - Date.now()) / 60_000)) : 60;
      throw new ApiError(
        429,
        "GENERATION_LIMIT",
        `You have used your ${config.GENERATIONS_PER_HOUR} generations for this hour. The app runs on a free model quota shared by everyone. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      );
    },
  };
}
