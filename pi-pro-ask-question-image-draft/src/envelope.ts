import type { NormalizedReview } from "./schema.ts";
import type { ReviewAnswer, ReviewResult, ReviewRevision } from "./state.ts";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

export interface VisualReviewAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
}

export interface VisualReviewResultDetails {
  version: 1;
  kind: "visual-review";
  reviewId: string;
  round: number;
  title?: string;
  provider?: string;
  model?: string;
  /** Original ask_user_question-compatible answer surface. */
  answers: VisualReviewAnswer[];
  cancelled: boolean;
  globalNote?: string;
  error?: string;
  /** Optional transient progress metadata supplied while explicit image generation runs. */
  progress?: {
    completed: number;
    total: number;
    optionId: string;
    path: string;
    provider: string;
    model: string;
    byteCount: number;
  };
  /** Rich visual-review details retained alongside the compatibility surface. */
  result: ReviewResult;
}

export interface VisualReviewToolResult {
  content: { type: "text"; text: string }[];
  details: VisualReviewResultDetails;
}

function answerText(answer: ReviewAnswer): string {
  if (answer.kind === "custom") return answer.customText?.trim() || answer.answer?.trim() || "(no response)";
  if (answer.kind === "multi") return answer.optionLabels?.join(", ") || answer.answer || "(no selection)";
  return answer.answer || answer.optionLabels?.[0] || "(no selection)";
}

export function formatAnswer(answer: ReviewAnswer, stagePrompt: string): string {
  const segments = [`"${stagePrompt}"="${answerText(answer).replace(/"/g, '\\"')}"`];
  if (answer.notes) segments.push(`user notes: ${answer.notes}`);
  return `${segments.join(". ")}.`;
}

export function formatRevision(revision: ReviewRevision): string {
  return `revision requested for stage ${revision.stageIndex + 1}: ${revision.feedback}`;
}

function legacyAnswerFor(answer: ReviewAnswer, questionIndex: number, question: string, preview?: string): VisualReviewAnswer {
  return {
    questionIndex,
    question,
    kind: answer.kind,
    answer: answer.kind === "multi" ? null : answer.answer,
    ...(answer.kind === "multi" ? { selected: answer.optionLabels ?? [] } : {}),
    ...(answer.notes ? { notes: answer.notes } : {}),
    ...(preview ? { preview } : {}),
  };
}

function legacyAnswers(result: ReviewResult, review: NormalizedReview): VisualReviewAnswer[] {
  const stageById = new Map(review.stages.map((stage) => [stage.id, stage]));
  return result.answers.flatMap((answer) => {
    const stage = stageById.get(answer.stageId);
    if (!stage) return [];
    const questionIndex = review.stages.indexOf(stage);
    const optionById = new Map(stage.options.map((option) => [option.id, option]));
    const preview = answer.kind === "option" && answer.optionIds?.length === 1
      ? optionById.get(answer.optionIds[0]!)?.preview
      : undefined;
    return [legacyAnswerFor(answer, questionIndex, stage.prompt, preview)];
  });
}

export function buildResponse(result: ReviewResult, review: NormalizedReview): VisualReviewToolResult {
  if (result.reviewId !== review.reviewId || result.round !== review.round) {
    throw new Error("Result identity does not match the normalized review.");
  }
  const answers = legacyAnswers(result, review);
  const details: VisualReviewResultDetails = {
    version: 1,
    kind: "visual-review",
    reviewId: result.reviewId,
    round: result.round,
    title: review.title,
    provider: review.provider,
    model: review.model,
    answers,
    cancelled: result.cancelled,
    ...(result.globalNote ? { globalNote: result.globalNote } : {}),
    ...(result.error ? { error: result.error } : {}),
    result,
  };
  let text: string;
  switch (result.status) {
    case "completed": {
      if (result.answers.length === 0 && !result.globalNote) {
        text = result.skippedStageIds?.length
          ? `Visual review completed with no recorded answers. The user skipped: ${result.skippedStageIds.join(", ")}.`
          : "Visual review completed with no recorded answers.";
      } else {
        const stageById = new Map(review.stages.map((stage) => [stage.id, stage]));
        const formatted = result.answers.map((answer) => {
          const stage = stageById.get(answer.stageId);
          return formatAnswer(answer, stage?.prompt ?? answer.stageId);
        });
        // A skipped stage is a decision the user made, and the envelope is the
        // only thing the model reads. Naming only the answered stages made an
        // explicit skip indistinguishable from a stage nobody was ever shown,
        // even though approval is gated on it.
        const skipped = result.skippedStageIds ?? [];
        if (skipped.length > 0) formatted.push(`skipped by the user: ${skipped.join(", ")}.`);
        if (result.globalNote) formatted.push(`global note: ${result.globalNote}.`);
        text = `${ENVELOPE_PREFIX} ${formatted.join(" ")} ${ENVELOPE_SUFFIX}`;
      }
      break;
    }
    case "revision":
      text = `Visual review revision requested (round ${result.round} → ${(result.revision?.requestedRound ?? result.round + 1)}). ${formatRevision(result.revision ?? { stageId: "unknown", stageIndex: 0, feedback: "unspecified", requestedRound: result.round + 1 })}. Regenerate the affected image(s), then call ask_user_question again with the same reviewId and the next round.`;
      break;
    case "rejected":
      text = `User rejected the visual review after round ${result.round}. No implementation should proceed from this proposal.`;
      break;
    case "cancelled":
      text = DECLINE_MESSAGE;
      break;
    case "fallback":
      text = result.fallback?.message ?? "Visual review UI is unavailable. Ask the user in plain chat instead; this is not a decline.";
      break;
    case "failed":
      // The request could not be started - a malformed review, an unreachable
      // image provider. It is not a decline, and saying so is the whole point:
      // a model that reads `cancelled` here tells the user they declined.
      text = `The visual review could not start: ${result.error ?? "the request was rejected"}. This is not a user decision - fix the request or the configuration and try again.`;
      break;
  }
  return { content: [{ type: "text", text }], details };
}

export function errorResponse(message: string, review?: NormalizedReview): VisualReviewToolResult {
  const result: ReviewResult = {
    version: 1,
    reviewId: review?.reviewId ?? "invalid-review",
    round: review?.round ?? 1,
    // `failed`, not `cancelled`: nothing about a malformed request or an
    // unreachable image provider is the user declining, and the guidelines tell
    // the model to read `cancelled` as exactly that.
    status: "failed",
    decision: "cancel",
    cancelled: false,
    answers: [],
    error: message,
  };
  return {
    content: [{ type: "text", text: `Visual review could not start: ${message}` }],
    details: {
      version: 1,
      kind: "visual-review",
      reviewId: result.reviewId,
      round: result.round,
      title: review?.title,
      provider: review?.provider,
      model: review?.model,
      answers: [],
      // `false`, matching `result.cancelled` on the very payload this sits in.
      // The prose above says "This is not a user decision"; the flag a level up
      // was still saying the user declined, and `PROMPT_GUIDELINES` tells the
      // model to read a cancelled decision as an explicit user cancellation.
      // `scripts/benchmark/compare.mjs` then filed every errored review under
      // `cancelled` for good.
      cancelled: false,
      error: message,
      result,
    },
  };
}
