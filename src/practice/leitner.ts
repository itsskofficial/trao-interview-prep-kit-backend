import type { Flashcard, Kit, Requirement } from "../kit/schema";

/**
 * Practice ordering: Leitner boxes. Every card sits in a box from 1 (does not
 * know it) to 5 (knows it cold). After each card the user says how confident
 * they felt, and the card moves:
 *
 *   1 "no idea"    -> back to box 1
 *   2 "shaky"      -> down one box
 *   3 "mostly"     -> up one box
 *   4 "confident"  -> up two boxes
 *
 * The next session takes cards never seen first, then the lowest box, then the
 * card seen longest ago. Interval-based schemes (SM-2) schedule reviews weeks
 * out; someone with an interview in five days needs "what am I worst at, now",
 * which is exactly what the lowest box is.
 */

export const BOXES = 5;
export const MASTERED_BOX = 4;
export const DEFAULT_SESSION_SIZE = 10;

export type Confidence = 1 | 2 | 3 | 4;

export interface CardProgress {
  box: number;
  seen: number;
  lastConfidence: Confidence;
  lastSeenAt: string;
}

export type Progress = Record<string, CardProgress>;

export function rate(previous: CardProgress | undefined, confidence: Confidence, now: Date): CardProgress {
  const box = previous?.box ?? 1;
  const moved = confidence === 1 ? 1 : confidence === 2 ? box - 1 : confidence === 3 ? box + 1 : box + 2;
  return {
    box: Math.max(1, Math.min(BOXES, moved)),
    seen: (previous?.seen ?? 0) + 1,
    lastConfidence: confidence,
    lastSeenAt: now.toISOString(),
  };
}

/** Cards for the next session, weakest first. Deterministic: ties keep the kit's own card order. */
export function nextSession(flashcards: Flashcard[], progress: Progress, size = DEFAULT_SESSION_SIZE): Flashcard[] {
  return flashcards
    .map((card, index) => ({ card, index, state: progress[card.id] }))
    .sort((a, b) => {
      if (!a.state || !b.state) return Number(Boolean(a.state)) - Number(Boolean(b.state)) || a.index - b.index;
      return a.state.box - b.state.box || a.state.lastSeenAt.localeCompare(b.state.lastSeenAt) || a.index - b.index;
    })
    .slice(0, size)
    .map(({ card }) => card);
}

export interface PracticeCoverage {
  total: number;
  covered: number;
  notCovered: number;
  mastered: number;
  /** Cards per box, index 0 being box 1. Unseen cards are not in any box. */
  boxes: number[];
}

export function practiceCoverage(flashcards: Flashcard[], progress: Progress): PracticeCoverage {
  const states = flashcards.flatMap((card) => (progress[card.id] ? [progress[card.id]!] : []));
  return {
    total: flashcards.length,
    covered: states.length,
    notCovered: flashcards.length - states.length,
    mastered: states.filter((state) => state.box >= MASTERED_BOX).length,
    boxes: Array.from({ length: BOXES }, (_, index) => states.filter((state) => state.box === index + 1).length),
  };
}

export interface WeakSpot {
  requirement: Requirement;
  /** Cards on this requirement where the user's latest answer was "no idea" or "shaky". */
  weakCards: number;
  unseenCards: number;
  totalCards: number;
  /** Questions in the kit that cover this requirement: what to go back to. */
  questionIds: string[];
}

/**
 * Where practice says the user is weakest, mapped back to what the posting
 * asks for. Must-haves come first, then the requirements with the most weak
 * cards. Weak means the user's latest answer on a card was "no idea" or
 * "shaky": a card answered "mostly" on first sight sits in a low box but is not
 * a weak spot. Never having looked is "not covered", not "weak".
 */
export function weakSpots(kit: Kit, progress: Progress): WeakSpot[] {
  return kit.role.requirements
    .map((requirement): WeakSpot => {
      const cards = kit.flashcards.filter((card) => card.requirement_ids.includes(requirement.id));
      return {
        requirement,
        weakCards: cards.filter((card) => (progress[card.id]?.lastConfidence ?? 4) <= 2).length,
        unseenCards: cards.filter((card) => !progress[card.id]).length,
        totalCards: cards.length,
        questionIds: kit.questions.filter((question) => question.requirement_ids.includes(requirement.id)).map((question) => question.id),
      };
    })
    .filter((spot) => spot.weakCards > 0)
    .sort(
      (a, b) =>
        Number(b.requirement.priority === "must") - Number(a.requirement.priority === "must") ||
        b.weakCards - a.weakCards ||
        a.requirement.id.localeCompare(b.requirement.id, undefined, { numeric: true }),
    );
}
