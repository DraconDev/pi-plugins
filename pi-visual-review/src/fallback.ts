import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeReview, type NormalizedReview } from "./schema.ts";
import { makeReviewState, type ReviewAnswer, type ReviewResult, type ReviewRevision } from "./state.ts";

export function fallbackText(review: NormalizedReview, reason: "no_ui" | "no_custom_ui" | "rpc"): string {
  const lines = [`Visual review could not open in this host (${reason}).`, "", `Review: ${review.title ?? "Untitled review"}`];
  for (const [index, stage] of review.stages.entries()) {
    lines.push("", `Stage ${index + 1}/${review.stages.length} — ${stage.header}`);
    lines.push(stage.prompt);
    for (const [optionIndex, option] of stage.options.entries()) {
      const image = option.image?.path ?? option.image?.url ?? (option.image?.dataUri ? "inline data URI" : undefined);
      const suffix = image ? ` [image: ${image}]` : "";
      lines.push(`  ${optionIndex + 1}. ${option.label}${suffix}`);
      if (option.description) lines.push(`     ${option.description}`);
      if (option.preview) lines.push(`     Preview: ${option.preview.replace(/\n+/g, " ").slice(0, 240)}`);
    }
    if (stage.allowOther) lines.push("  Type something. — enter a custom answer");
    if (stage.allowRevision) lines.push("  Request revision — describe changes to make");
  }
  lines.push("", "Ask the user to answer these stages in plain chat. Do not interpret host unavailability as a decline.");
  return lines.join("\n");
}

export function makeFallbackResult(review: NormalizedReview, reason: "no_ui" | "no_custom_ui" | "rpc"): ReviewResult {
  const state = makeReviewState(review, [], "fallback");
  return {
    version: 1,
    reviewId: review.reviewId,
    round: review.round,
    status: "fallback",
    decision: "fallback",
    cancelled: false,
    answers: [],
    fallback: { reason, message: fallbackText(review, reason) },
  };
}

export async function runDialogReview(
  ctx: ExtensionContext,
  review: NormalizedReview,
  initialAnswers: readonly ReviewAnswer[] = [],
): Promise<ReviewResult> {
  const answers = new Map(initialAnswers.map((answer) => [answer.stageId, answer]));
  for (const [stageIndex, stage] of review.stages.entries()) {
    const options = stage.options.map((option) => {
      const image = option.image?.path ?? option.image?.url;
      return image ? `${option.label} — ${image}` : option.label;
    });
    if (stage.allowOther) options.push("Type something.");
    if (stage.allowRevision) options.push("Request revision");
    const selected = await ctx.ui.select(stage.prompt, options);
    if (selected === undefined) {
      return { version: 1, reviewId: review.reviewId, round: review.round, status: "cancelled", decision: "cancel", cancelled: true, answers: [...answers.values()] };
    }
    if (selected === "Type something.") {
      const text = await ctx.ui.input("Your answer", stage.description);
      if (text === undefined) {
        return { version: 1, reviewId: review.reviewId, round: review.round, status: "cancelled", decision: "cancel", cancelled: true, answers: [...answers.values()] };
      }
      answers.set(stage.id, { stageId: stage.id, stageIndex, kind: "custom", answer: text.trim() || null, customText: text.trim() || undefined });
      continue;
    }
    if (selected === "Request revision") {
      const feedback = await ctx.ui.input("What should be revised?", "Describe the changes you want");
      if (feedback === undefined || !feedback.trim()) {
        return { version: 1, reviewId: review.reviewId, round: review.round, status: "cancelled", decision: "cancel", cancelled: true, answers: [...answers.values()] };
      }
      const revision: ReviewRevision = { stageId: stage.id, stageIndex, feedback: feedback.trim(), requestedRound: review.round + 1 };
      return { version: 1, reviewId: review.reviewId, round: review.round, status: "revision", decision: "revision", cancelled: false, answers: [...answers.values()], revision };
    }
    const option = stage.options.find((candidate) => candidate.label === selected || `${candidate.label} — ${candidate.image?.path ?? candidate.image?.url}` === selected);
    if (!option) {
      return { version: 1, reviewId: review.reviewId, round: review.round, status: "cancelled", decision: "cancel", cancelled: true, answers: [...answers.values()] };
    }
    answers.set(stage.id, { stageId: stage.id, stageIndex, kind: stage.multiSelect ? "multi" : "option", optionIds: [option.id], optionLabels: [option.label], answer: option.label });
  }
  return { version: 1, reviewId: review.reviewId, round: review.round, status: "completed", decision: "approve", cancelled: false, answers: [...answers.values()] };
}
