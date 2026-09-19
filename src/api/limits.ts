import type { ObjectId } from "mongodb";
import type { Config } from "../config";
import type { Database } from "../persistence/mongo";
import { ApiError } from "./errors";

const HOUR_MS = 60 * 60 * 1000;

export interface UsageLimiter {
  /** Records `count` model-spending actions for this user, or refuses all of them with a 429 if that would pass the hourly allowance. */
  spend(userId: ObjectId, kind: "generation" | "regeneration", count?: number): Promise<void>;
}

/**
 * The deployed app is public, and every kit or regeneration spends requests from a free-tier
 * quota shared by everyone. One account cannot use it all: each gets an hourly allowance.
 * Entries expire on their own through a TTL index, so nothing needs cleaning up.
 */
export function createUsageLimiter(db: Database, config: Config): UsageLimiter {
  return {
    async spend(userId, kind, count = 1) {
      const since = new Date(Date.now() - HOUR_MS);
      const already = await db.usage.countDocuments({ userId, at: { $gte: since } });

      if (already + count > config.GENERATIONS_PER_HOUR) {
        const oldest = await db.usage.findOne({ userId, at: { $gte: since } }, { sort: { at: 1 } });
        const minutes = oldest ? Math.max(1, Math.ceil((oldest.at.getTime() + HOUR_MS - Date.now()) / 60_000)) : 60;
        throw new ApiError(
          429,
          "GENERATION_LIMIT",
          `You have used ${already} of your ${config.GENERATIONS_PER_HOUR} generations for this hour. The app runs on a free model quota shared by everyone. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        );
      }

      const at = new Date();
      await db.usage.insertMany(Array.from({ length: count }, () => ({ userId, kind, at })));
    },
  };
}
