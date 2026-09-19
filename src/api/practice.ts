import { Router } from "express";
import type { ObjectId } from "mongodb";
import { z } from "zod";
import { reconcile } from "../builder/operations";
import type { Kit } from "../kit/schema";
import type { KitRepository } from "../persistence/kits";
import { DEFAULT_SESSION_SIZE, nextSession, practiceCoverage, rate, weakSpots, type Confidence, type Progress } from "../practice/leitner";
import { ApiError, parse } from "./errors";

const RatingSchema = z.object({
  flashcard_id: z.string().min(1),
  confidence: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)], "Confidence is 1 (no idea) to 4 (confident)."),
});
const SessionQuerySchema = z.object({ size: z.coerce.number().int().min(1).max(100).default(DEFAULT_SESSION_SIZE) });
const ReplanSchema = z.object({ from_day: z.number().int().min(1) });

function overview(kit: Kit, progress: Progress, size: number) {
  return {
    session: nextSession(kit.flashcards, progress, size).map((card) => card.id),
    coverage: practiceCoverage(kit.flashcards, progress),
    weak_spots: weakSpots(kit, progress),
    progress: Object.fromEntries(kit.flashcards.flatMap((card) => (progress[card.id] ? [[card.id, progress[card.id]]] : []))),
  };
}

/** Mounted behind requireAuth, beside the other kit routes. */
export function practiceRouter(kits: KitRepository): Router {
  const router = Router();
  const owner = (locals: Record<string, unknown>) => locals.userId as ObjectId;

  router.get("/:id/practice", async (request, response) => {
    const { size } = parse(SessionQuerySchema, request.query);
    const found = await kits.practice(owner(response.locals), request.params.id);
    if (!found) throw ApiError.notFound("Kit");
    response.json(overview(found.kit, found.progress, size));
  });

  router.post("/:id/practice/ratings", async (request, response) => {
    const { flashcard_id: cardId, confidence } = parse(RatingSchema, request.body);
    let result: ReturnType<typeof overview> | undefined;

    const saved = await kits.mutate(owner(response.locals), request.params.id, (doc) => {
      if (!doc.kit.flashcards.some((card) => card.id === cardId)) throw new ApiError(404, "NOT_FOUND", `Flashcard ${cardId} does not exist in this kit.`);
      const progress = { ...(doc.practice ?? {}), [cardId]: rate(doc.practice?.[cardId], confidence as Confidence, new Date()) };
      result = overview(doc.kit, progress, DEFAULT_SESSION_SIZE);
      return { set: { practice: progress } };
    });
    if (!saved || !result) throw ApiError.notFound("Kit");
    response.json(result);
  });

  router.delete("/:id/practice", async (request, response) => {
    const saved = await kits.mutate(owner(response.locals), request.params.id, () => ({ unset: ["practice"] }));
    if (!saved) throw ApiError.notFound("Kit");
    response.json(overview(saved.kit, {}, DEFAULT_SESSION_SIZE));
  });

  /**
   * Re-plans the schedule from `from_day` on around the user's weak spots: the questions covering the
   * requirements they are struggling with are dealt out first. Days before `from_day` stay as they were.
   */
  router.post("/:id/practice/replan", async (request, response) => {
    const { from_day: fromDay } = parse(ReplanSchema, request.body);
    const saved = await kits.mutate(owner(response.locals), request.params.id, (doc) => {
      if (fromDay > doc.kit.schedule.days_available) {
        throw new ApiError(400, "INVALID_OPERATION", `This schedule has ${doc.kit.schedule.days_available} day(s).`);
      }
      const focus = [...new Set(weakSpots(doc.kit, doc.practice ?? {}).flatMap((spot) => spot.questionIds))];
      if (focus.length === 0) throw new ApiError(409, "NO_WEAK_SPOTS", "Practice has not found any weak spots yet, so there is nothing to re-plan around.");
      const schedule = { ...doc.kit.schedule, replan: { from_day: fromDay, focus_question_ids: focus } };
      return { state: { kit: reconcile({ ...doc.kit, schedule }), counters: doc.counters } };
    });
    if (!saved) throw ApiError.notFound("Kit");
    response.json(saved);
  });

  return router;
}
