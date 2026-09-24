import type { NormalizedReview } from "./schema.ts";
import type { ReviewAnswer, ReviewResult, ReviewRevision } from "./state.ts";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

export interface VisualReviewResultDetails {
  version: 1;
  kind: "visual-review";
  reviewId: string;
  round: number;
  title?: string;
  provider?: string;
  model?: string;
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
  return `"${stagePrompt}"="${answerText(answer).replace(/"/g, '\\"')}"`;
}

export function formatRevision(revision: ReviewRevision): string {
  return `revision requested for stage ${revision.stageIndex + 1}: ${revision.feedback}`;
}

export function buildResponse(result: ReviewResult, review: NormalizedReview): VisualReviewToolResult {
  if (result.reviewId !== review.reviewId || result.round !== review.round) {
    throw new Error("Result identity does not match the normalized review.");
  }
  const details: VisualReviewResultDetails = {
    version: 1,
    kind: "visual-review",
    reviewId: result.reviewId,
    round: result.round,
    title: review.title,
    provider: review.provider,
    model: review.model,
    result,
  };
  let text: string;
  switch (result.status) {
    case "completed": {
      if (result.answers.length === 0) {
        text = "Visual review completed with no recorded answers.";
      } else {
        const stageById = new Map(review.stages.map((stage) => [stage.id, stage]));
        const formatted = result.answers.map((answer) => {
          const stage = stageById.get(answer.stageId);
          return formatAnswer(answer, stage?.prompt ?? answer.stageId);
        });
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
  }
  return { content: [{ type: "text", text }], details };
}

export function errorResponse(message: string, review?: NormalizedReview): VisualReviewToolResult {
  const result: ReviewResult = {
    version: 1,
    reviewId: review?.reviewId ?? "invalid-review",
    round: review?.round ?? 1,
    status: "cancelled",
    decision: "cancel",
    cancelled: true,
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
      result,
    },
  };
}
