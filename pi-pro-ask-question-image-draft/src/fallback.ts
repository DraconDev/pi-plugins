import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { NormalizedOption, NormalizedReview, NormalizedStage } from "./schema.ts";
import {
  makeCustomAnswer,
  makeOptionAnswer,
  makeReviewResult,
  missingRequiredStages,
  type ReviewAnswer,
  type ReviewResult,
  type ReviewRevision,
} from "./state.ts";

export type FallbackReason = "no_ui" | "no_custom_ui" | "rpc";

const OTHER_LABEL = "Type something.";
const REVISION_LABEL = "Request revision";
const SKIP_LABEL = "Skip stage";
const DONE_LABEL = "Done selecting";
const APPROVE_LABEL = "Approve review";
const REJECT_LABEL = "Reject review";

export function fallbackText(review: NormalizedReview, reason: FallbackReason): string {
  const lines = [
    `Visual review could not open in this host (${reason}).`,
    "The user has not answered and this is not a decline.",
    "",
    `Review: ${review.title ?? "Untitled review"} (round ${review.round})`,
  ];

  for (const [index, stage] of review.stages.entries()) {
    lines.push("", `Stage ${index + 1}/${review.stages.length} — ${stage.header}`);
    if (stage.kind === "draft") lines.push("(Visual draft stage)");
    lines.push(stage.prompt);
    if (stage.required) lines.push("(required)");
    if (stage.imagePrompt) lines.push(`Next image prompt: ${stage.imagePrompt}`);

    for (const [optionIndex, option] of stage.options.entries()) {
      const image = option.image?.path ?? option.image?.url ?? (option.image?.dataUri ? "inline data URI" : undefined);
      const suffix = image ? ` — image: ${image}` : "";
      const alt = option.image?.alt ? ` — ${option.image.alt}` : "";
      lines.push(`  [ ] ${optionIndex + 1}. ${option.label}${suffix}${alt}`);
      if (option.description) lines.push(`     ${option.description}`);
      if (option.preview) {
        const preview = option.preview.replace(/\r\n/g, "\n").replace(/\r/g, "");
        lines.push(`     Preview: ${preview.slice(0, 500).replace(/\n+/g, " ")}`);
      }
    }
    if (stage.multiSelect) lines.push(`  ${DONE_LABEL} — commit the checked options`);
    if (stage.allowOther) lines.push(`  ${OTHER_LABEL} — enter a custom answer`);
    if (!stage.required) lines.push(`  ${SKIP_LABEL} — continue without answering`);
    if (stage.allowRevision) lines.push(`  ${REVISION_LABEL} — describe changes for the next image round`);
  }

  if (review.notes) lines.push("", `Notes: ${review.notes}`);
  lines.push(
    "",
    "Ask the user these questions in plain chat. Return explicit options, custom answers, and revision/cancel decisions when the user responds; do not infer a response from host unavailability.",
  );
  return lines.join("\n");
}

export function makeFallbackResult(review: NormalizedReview, reason: FallbackReason): ReviewResult {
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

function displayOption(stage: NormalizedStage, option: NormalizedOption): string {
  const image = option.image?.path ?? option.image?.url;
  return image ? `${option.label} — ${image}` : option.label;
}

function findOption(stage: NormalizedStage, selected: string): NormalizedOption | undefined {
  const unselected = selected.startsWith("✓ ") ? selected.slice(2) : selected;
  return stage.options.find((option) => displayOption(stage, option) === unselected || option.label === unselected);
}

function orderedSelected(stage: NormalizedStage, ids: ReadonlySet<string>): NormalizedOption[] {
  return stage.options.filter((option) => ids.has(option.id));
}

function cancelledResult(review: NormalizedReview, answers: Map<string, ReviewAnswer>): ReviewResult {
  return makeReviewResult(review, "cancel", answers);
}

function selectTitle(stage: NormalizedStage, selected: readonly string[]): string {
  if (!stage.multiSelect || selected.length === 0) return stage.prompt;
  return `${stage.prompt}\nSelected: ${selected.join(", ")}`;
}

function resultWithRevision(
  review: NormalizedReview,
  answers: Map<string, ReviewAnswer>,
  stage: NormalizedStage,
  stageIndex: number,
  feedback: string,
): ReviewResult {
  const revision: ReviewRevision = {
    stageId: stage.id,
    stageIndex,
    feedback,
    requestedRound: review.round + 1,
  };
  return makeReviewResult(review, "revision", answers, revision);
}

/**
 * Portable sequential dialog walker used by RPC/ACP hosts. `select()` has no
 * multi-select API, so a multi-select stage is committed with a dedicated
 * "Done selecting" choice. The caller can select and deselect choices by
 * toggling them across repeated dialogs.
 */
export async function runDialogReview(
  ctx: ExtensionContext,
  review: NormalizedReview,
  initialAnswers: readonly ReviewAnswer[] = [],
): Promise<ReviewResult> {
  const answers = new Map<string, ReviewAnswer>();
  for (const answer of initialAnswers) {
    if (!answers.has(answer.stageId)) answers.set(answer.stageId, { ...answer, optionIds: answer.optionIds ? [...answer.optionIds] : undefined, optionLabels: answer.optionLabels ? [...answer.optionLabels] : undefined, optionValues: answer.optionValues ? [...answer.optionValues] : undefined });
  }

  for (const [stageIndex, stage] of review.stages.entries()) {
    const previous = answers.get(stage.id);
    const optionIds = new Set(
      previous?.kind === "multi" ? previous.optionIds?.filter((id) => stage.options.some((option) => option.id === id)) ?? [] : [],
    );
    let confirmed = !stage.multiSelect && previous !== undefined;
    let skipStage = false;
    let customText: string | undefined;
    let revisionFeedback: string | undefined;

    while (!confirmed && !skipStage && revisionFeedback === undefined && customText === undefined) {
      const selectedLabels = orderedSelected(stage, optionIds).map((option) => option.label);
      const choices = stage.options.map((option) => displayOption(stage, option));
      if (stage.multiSelect) {
        for (const option of stage.options) {
          if (optionIds.has(option.id)) {
            const position = choices.indexOf(displayOption(stage, option));
            if (position >= 0) choices[position] = `✓ ${choices[position]}`;
          }
        }
        choices.push(DONE_LABEL);
      }
      if (stage.allowOther) choices.push(OTHER_LABEL);
      if (!stage.required) choices.push(SKIP_LABEL);
      if (stage.allowRevision) choices.push(REVISION_LABEL);
      choices.push(APPROVE_LABEL, REJECT_LABEL);

      const selected = await ctx.ui.select(selectTitle(stage, selectedLabels), choices, { signal: ctx.signal });
      if (selected === undefined) return cancelledResult(review, answers);

      if (stage.multiSelect && selected === DONE_LABEL) {
        if (optionIds.size === 0) {
          if (stage.required) {
            const retry = await ctx.ui.confirm("Selection required", "Choose at least one option before continuing. Try again?", {
              signal: ctx.signal,
            });
            if (retry === false) return cancelledResult(review, answers);
            continue;
          }
          continue;
        }
        answers.set(stage.id, makeOptionAnswer(stage, stageIndex, orderedSelected(stage, optionIds)));
        confirmed = true;
        continue;
      }

      if (selected === OTHER_LABEL) {
        const text = await ctx.ui.input("Your answer", stage.description, { signal: ctx.signal });
        if (text === undefined) return cancelledResult(review, answers);
        const trimmed = text.trim();
        if (!trimmed) continue;
        customText = trimmed;
        continue;
      }
      if (selected === SKIP_LABEL) {
        skipStage = true;
        continue;
      }
      if (selected === REVISION_LABEL) {
        const feedback = await ctx.ui.input("What should be revised?", "Describe the changes you want", { signal: ctx.signal });
        if (feedback === undefined) return cancelledResult(review, answers);
        const trimmed = feedback.trim();
        if (!trimmed) continue;
        revisionFeedback = trimmed;
        continue;
      }
      if (selected === APPROVE_LABEL) {
        const missingStage = missingRequiredStages(review, answers)[0];
        const missing = missingStage
          ? `Answer the required stage “${missingStage.header}” before approving. Continue reviewing?`
          : "Optional stages are still unresolved. Answer or explicitly skip each optional stage before approving. Continue reviewing?";
        if (missing) {
          const retry = await ctx.ui.confirm(
            "Review incomplete",
            missing,
            { signal: ctx.signal },
          );
          if (retry === false) return cancelledResult(review, answers);
          continue;
        }
        // Approval is a terminal action. It must not delete the current answer.
        return makeReviewResult(review, "approve", answers);
      }
      if (selected === REJECT_LABEL) return makeReviewResult(review, "reject", answers);

      const option = findOption(stage, selected);
      if (!option) continue;
      if (stage.multiSelect) {
        if (optionIds.has(option.id)) optionIds.delete(option.id);
        else optionIds.add(option.id);
        continue;
      }
      answers.set(stage.id, makeOptionAnswer(stage, stageIndex, [option]));
      confirmed = true;
    }

    if (skipStage) {
      answers.delete(stage.id);
      continue;
    }
    if (revisionFeedback !== undefined) {
      return resultWithRevision(review, answers, stage, stageIndex, revisionFeedback);
    }
    if (customText !== undefined) {
      answers.set(stage.id, makeCustomAnswer(stage, stageIndex, customText));
    }
  }

  // Every required stage has been answered at this point. Keep the final
  // confirmation explicit so the portable path has the same approval boundary.
  const approved = await ctx.ui.confirm("Visual review", "Approve these answers and continue?", { signal: ctx.signal });
  if (!approved) return makeReviewResult(review, "reject", answers);
  return makeReviewResult(review, "approve", answers);
}
