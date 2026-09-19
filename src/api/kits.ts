import { Router } from "express";
import type { ObjectId } from "mongodb";
import type { KitRepository } from "../persistence/kits";
import { ApiError } from "./errors";

/** Mounted behind requireAuth, so `response.locals.userId` is always set here. */
export function kitsRouter(kits: KitRepository): Router {
  const router = Router();
  const userId = (locals: Record<string, unknown>) => locals.userId as ObjectId;

  router.get("/", async (_request, response) => {
    response.json({ kits: await kits.list(userId(response.locals)) });
  });

  router.get("/:id", async (request, response) => {
    const kit = await kits.get(userId(response.locals), request.params.id);
    if (!kit) throw ApiError.notFound("Kit");
    response.json(kit);
  });

  router.delete("/:id", async (request, response) => {
    const removed = await kits.remove(userId(response.locals), request.params.id);
    if (!removed) throw ApiError.notFound("Kit");
    response.status(204).end();
  });

  return router;
}
