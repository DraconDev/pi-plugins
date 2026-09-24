import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { normalizeReview, type NormalizedReview } from "./schema.ts";
import { makeCustomAnswer, makeOptionAnswer, makeReviewState, type ReviewAnswer, type ReviewResult, type ReviewRevision } from "./state.ts";

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

function selectedOption(stage: NormalizedReview["stages"][number], selected: string) {
  return stage.options.find((option) => option.label === selected || `${option.label} — ${option.image?.path ?? option.image?.url}` === selected);
}

function cancel(review: NormalizedReview, answers: Map<string, ReviewAnswer>): ReviewResult {
  return {
    version: 1,
    reviewId: review.reviewId,
    round: review.round,
    status: "cancelled",
    decision: "cancel",
    cancelled: true,
    answers: [...answers.values()],
  };
}

/**
 * Dialog fallback for RPC/ACP hosts. It intentionally uses only the portable
 * select/input primitives, so a host that cannot render the custom wizard can
 * still complete a review.
 */
export async function runDialogReview(ctx: ExtensionContext, review: NormalizedReview, initialAnswers: readonly ReviewAnswer[] = []): Promise<ReviewResult> {
  const answers = new Map(initialAnswers.map((answer) => [answer.stageId, { ...answer }]));
  for (const [stageIndex, stage] of review.stages.entries()) {
    const options = stage.options.map((option) => {
      const image = option.image?.path ?? option.image?.url;
      return image ? `${option.label} — ${image}` : option.label;
    });
    if (stage.allowOther) options.push("Type something.");
    if (stage.allowRevision) options.push("Request revision");

    const selected = await ctx.ui.select(stage.prompt, options, { signal: ctx.signal });
    if (selected === undefined) return cancel(review, answers);
    if (selected === "Type something.") {
      const text = await ctx.ui.input("Your answer", stage.description, { signal: ctx.signal });
      if (text === undefined) return cancel(review, answers);
      answers.set(stage.id, makeCustomAnswer(stage, stageIndex, text));
      continue;
    }
    if (selected === "Request revision") {
      const feedback = await ctx.ui.input("What should be revised?", "Describe the changes you want", { signal: ctx.signal });
      if (feedback === undefined || !feedback.trim()) return cancel(review, answers);
      const revision: ReviewRevision = { stageId: stage.id, stageIndex, feedback: feedback.trim(), requestedRound: review.round + 1 };
      return { version: 1, reviewId: review.reviewId, round: review.round, status: "revision", decision: "revision", cancelled: false, answers: [...answers.values()], revision };
    }

    const option = selectedOption(stage, selected);
    if (!option) return cancel(review, answers);
    answers.set(stage.id, makeOptionAnswer(stage, stageIndex, [option]));
  }

  const approved = await ctx.ui.confirm("Visual review", "Approve these answers and continue?", { signal: ctx.signal });
  if (approved === undefined) return cancel(review, answers);
  return {
    version: 1,
    reviewId: review.reviewId,
    round: review.round,
    status: approved ? "completed" : "rejected",
    decision: approved ? "approve" : "reject",
    cancelled: false,
    answers: [...answers.values()],
  };
}
