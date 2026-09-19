import { Router, type Response } from "express";
import type { ObjectId } from "mongodb";
import { z } from "zod";
import {
  addFlashcard, addQuestion, BuilderError, deleteFlashcard, deleteQuestion, moveQuestion, patchBrief, patchFlashcard,
  patchQuestion, reorderFlashcards, reorderQuestions, setPinned, type BuilderState,
} from "../builder/operations";
import { RegenerationRefused, type Regenerator } from "../builder/regenerator";
import { QuestionCategorySchema } from "../kit/schema";
import type { KitRepository, StoredKit } from "../persistence/kits";
import { ApiError, parse } from "./errors";

const text = (max: number) => z.string().trim().max(max, `At most ${max} characters.`);
const requirementIds = z.array(z.string().min(1)).max(50);
const difficulty = z.number().int().min(1).max(3);

const QuestionPatchSchema = z
  .object({ prompt: text(2_000).min(1, "A question needs a prompt."), answer_outline: text(6_000), difficulty, requirement_ids: requirementIds })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to change.");
const NewQuestionSchema = z.object({
  category: QuestionCategorySchema,
  prompt: text(2_000).min(1, "A question needs a prompt."),
  answer_outline: text(6_000).optional(),
  difficulty: difficulty.optional(),
  requirement_ids: requirementIds.optional(),
});
const MoveSchema = z.object({ category: QuestionCategorySchema, index: z.number().int().min(0) });
const QuestionOrderSchema = z.object({ category: QuestionCategorySchema, ids: z.array(z.string()).max(500) });

const FlashcardPatchSchema = z
  .object({ front: text(500).min(1, "A flashcard needs a front."), back: text(3_000), requirement_ids: requirementIds })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to change.");
const NewFlashcardSchema = z.object({ front: text(500).min(1, "A flashcard needs a front."), back: text(3_000).optional(), requirement_ids: requirementIds.optional() });
const FlashcardOrderSchema = z.object({ ids: z.array(z.string()).max(500) });

const BriefPatchSchema = z
  .object({ summary: text(4_000), what_they_do: text(4_000) })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to change.");

const PinSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), id: z.string(), pinned: z.boolean() }),
  z.object({ kind: z.literal("flashcard"), id: z.string(), pinned: z.boolean() }),
  z.object({ kind: z.literal("brief"), pinned: z.boolean() }),
]);

const RegenerateSchema = z.discriminatedUnion("section", [
  z.object({ section: z.literal("schedule") }),
  z.object({ section: z.literal("brief"), force: z.boolean().optional() }),
  z.object({ section: z.literal("questions"), category: QuestionCategorySchema }),
]);

/**
 * One small request per change, never the whole kit. The interface applies a
 * change locally first and sends it here in the background; each request
 * touches only what it names, so two of them cannot overwrite each other.
 * Mounted behind requireAuth, beside the read-only kit routes.
 */
export function builderRouter(kits: KitRepository, regenerator: Regenerator): Router {
  const router = Router({ mergeParams: true });

  /** Applies a pure builder operation to the stored kit and answers with the result. */
  async function apply(response: Response, kitId: string, operation: (state: BuilderState) => BuilderState, extra: object = {}, status = 200) {
    const saved = await guarded(() => kits.mutate(response.locals.userId as ObjectId, kitId, (doc) => ({ state: operation({ kit: doc.kit, counters: doc.counters }) })));
    response.status(status).json({ ...present(saved), ...extra });
  }

  router.patch("/:id/brief", async (request, response) => {
    const patch = parse(BriefPatchSchema, request.body);
    await apply(response, request.params.id, (state) => patchBrief(state, patch));
  });

  router.post("/:id/questions", async (request, response) => {
    const input = parse(NewQuestionSchema, request.body);
    let createdId = "";
    await guarded(async () => {
      const saved = await kits.mutate(response.locals.userId as ObjectId, request.params.id, (doc) => {
        const added = addQuestion({ kit: doc.kit, counters: doc.counters }, input);
        createdId = added.id;
        return { state: added.state };
      });
      response.status(201).json({ ...present(saved), createdId });
    });
  });

  // Registered before "/:id/questions/:questionId" so that "order" is not taken for a question id.
  router.put("/:id/questions/order", async (request, response) => {
    const { category, ids } = parse(QuestionOrderSchema, request.body);
    await apply(response, request.params.id, (state) => reorderQuestions(state, category, ids));
  });

  router.patch("/:id/questions/:questionId", async (request, response) => {
    const patch = parse(QuestionPatchSchema, request.body);
    await apply(response, request.params.id, (state) => patchQuestion(state, request.params.questionId, patch));
  });

  router.delete("/:id/questions/:questionId", async (request, response) => {
    await apply(response, request.params.id, (state) => deleteQuestion(state, request.params.questionId));
  });

  router.post("/:id/questions/:questionId/move", async (request, response) => {
    const { category, index } = parse(MoveSchema, request.body);
    await apply(response, request.params.id, (state) => moveQuestion(state, request.params.questionId, category, index));
  });

  router.post("/:id/flashcards", async (request, response) => {
    const input = parse(NewFlashcardSchema, request.body);
    let createdId = "";
    await guarded(async () => {
      const saved = await kits.mutate(response.locals.userId as ObjectId, request.params.id, (doc) => {
        const added = addFlashcard({ kit: doc.kit, counters: doc.counters }, input);
        createdId = added.id;
        return { state: added.state };
      });
      response.status(201).json({ ...present(saved), createdId });
    });
  });

  router.put("/:id/flashcards/order", async (request, response) => {
    const { ids } = parse(FlashcardOrderSchema, request.body);
    await apply(response, request.params.id, (state) => reorderFlashcards(state, ids));
  });

  router.patch("/:id/flashcards/:flashcardId", async (request, response) => {
    const patch = parse(FlashcardPatchSchema, request.body);
    await apply(response, request.params.id, (state) => patchFlashcard(state, request.params.flashcardId, patch));
  });

  router.delete("/:id/flashcards/:flashcardId", async (request, response) => {
    await apply(response, request.params.id, (state) => deleteFlashcard(state, request.params.flashcardId));
  });

  router.put("/:id/pins", async (request, response) => {
    const { pinned, ...target } = parse(PinSchema, request.body);
    await apply(response, request.params.id, (state) => setPinned(state, target, pinned));
  });

  router.post("/:id/regenerate", async (request, response) => {
    const body = parse(RegenerateSchema, request.body);
    const saved = await guarded(() => regenerator.start(response.locals.userId as ObjectId, request.params.id, body));
    // 202: the kit now says a section is regenerating; poll the kit to see it finish. The schedule is instant.
    response.status(body.section === "schedule" ? 200 : 202).json(present(saved));
  });

  router.post("/:id/regenerate/undo", async (request, response) => {
    response.json(present(await guarded(() => regenerator.undo(response.locals.userId as ObjectId, request.params.id))));
  });

  return router;
}

function present(saved: StoredKit | undefined): StoredKit {
  if (!saved) throw ApiError.notFound("Kit");
  return saved;
}

/** Turns the builder's own refusals into API errors with a status the interface can act on. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BuilderError) throw new ApiError(error.code === "NOT_FOUND" ? 404 : 400, error.code, error.message);
    if (error instanceof RegenerationRefused) throw new ApiError(409, error.code, error.message);
    throw error;
  }
}
