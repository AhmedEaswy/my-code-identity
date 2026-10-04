/**
 * What finishing a lesson unlocks.
 *
 * Finishing a lesson produces a single server signal: did it finish, is there a
 * quiz, did the quiz pass, and — if the course is over — was a certificate
 * actually issued. Turning that into "advance", "retake", or "certificate" is
 * the one place the rule lives, so the quiz screen, the lesson screen, and the
 * course player cannot disagree about when the course is over.
 *
 * The rule that used to be wrong: a missing next lesson was treated as proof
 * the course was finished. It is not. The next-lesson pointer is local to the
 * immediate sequence; a partial outline, or one where a later unit is still
 * unfinished, reports "no next lesson" while the course is very much ongoing.
 * The only trustworthy proof of completion is a certificate the backend
 * actually issued.
 */

export interface LessonCompletion {
  finished: boolean;
  quizRequired: boolean;
  quizPassed: boolean;
  passingPercent: number;
  scorePercent: number | null;
  nextLessonId: number | null;
  nextLessonSlug: string | null;
  certificateNumber: string | null;
}

export interface NextLesson {
  id: number | null;
  slug: string | null;
}

export type ProgressionReason =
  | "lesson_not_finished"
  | "quiz_not_passed"
  | "advance_to_next_lesson"
  | "certificate_offered"
  | "done_without_certificate";

export interface Progression {
  canAdvance: boolean;
  certificateOffered: boolean;
  nextLesson: NextLesson | null;
  reason: ProgressionReason;
}

/**
 * The server normally sends `passed`; when a payload only carries scores, the
 * comparison has to be explicit or an ungraded attempt counts as a pass.
 */
export const didPass = (scorePercent: number | null, passingPercent: number): boolean =>
  scorePercent !== null && scorePercent >= passingPercent;

const isIssued = (certificateNumber: string | null): boolean =>
  certificateNumber !== null && certificateNumber.trim() !== "";

export function resolveProgression(result: LessonCompletion): Progression {
  if (!result.finished) {
    return {
      canAdvance: false,
      certificateOffered: false,
      nextLesson: null,
      reason: "lesson_not_finished",
    };
  }

  // A quiz that was not passed is a retake, even when a next lesson exists:
  // advancing would let a learner skip the gate the quiz was placed there for.
  if (result.quizRequired && !result.quizPassed) {
    return {
      canAdvance: false,
      certificateOffered: false,
      nextLesson: null,
      reason: "quiz_not_passed",
    };
  }

  const hasNext = result.nextLessonId !== null || result.nextLessonSlug !== null;

  if (hasNext) {
    return {
      canAdvance: true,
      certificateOffered: false,
      nextLesson: { id: result.nextLessonId, slug: result.nextLessonSlug },
      reason: "advance_to_next_lesson",
    };
  }

  // End of the immediate sequence. Offer the certificate only if one exists;
  // otherwise this is simply a lesson with nothing after it yet.
  if (isIssued(result.certificateNumber)) {
    return {
      canAdvance: false,
      certificateOffered: true,
      nextLesson: null,
      reason: "certificate_offered",
    };
  }

  return {
    canAdvance: false,
    certificateOffered: false,
    nextLesson: null,
    reason: "done_without_certificate",
  };
}
