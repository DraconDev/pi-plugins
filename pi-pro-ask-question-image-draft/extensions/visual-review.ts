import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { buildResponse, errorResponse, type VisualReviewResultDetails } from "../src/envelope.ts";
import { fallbackText, makeFallbackResult, runDialogReview } from "../src/fallback.ts";
import { generateReviewImages, ImageGenerationError } from "../src/image-generator.ts";
import {
  findReviewState,
  makeReviewState,
  mergeAnswers,
  type GeneratedImageReference,
  type ReviewAnswer,
  type ReviewResult,
  type ReviewState,
} from "../src/state.ts";
import {
  normalizeReview,
  ReviewParamsSchema,
  validateReview,
  type NormalizedReview,
  type ReviewParams,
} from "../src/schema.ts";
import { runVisualReviewWizard } from "../src/tui.ts";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const REVIEW_STATE_CUSTOM_TYPE = "pi-visual-review-state";
export const TOOL_DESCRIPTION = `Ask the user for a staged visual review with optional image-backed choices, revisions, and explicit outcomes.

Use this tool when a decision requires the user's approval, especially when comparing generated mockups, charts, UI concepts, or other visual artifacts. For a visual comparison, either set an option's explicit generate.prompt (the built-in Agnes adapter saves a local image) or pass an image path, URL, or data URI produced by another image-generation tool. Image generation is never implicit and can consume provider quota.

For staged review, provide stages with ordered prompts and options. For compatibility, the legacy questions[] shape is also accepted. Each stage defaults to allowOther: true, allowRevision: true, required: true, and multiSelect: false. To generate an image as part of the review, set option.generate.prompt explicitly; the tool calls the selected provider (Agnes by default) and then displays the saved local image. Do not author reserved sentinel labels such as "Type something." or "Request revision".

If a user requests changes, return a revision result and call this tool again with the same reviewId, the next round, regenerated image references, and resetStageIds for stages that must be reconsidered. Preserve the reviewId in the model workflow.`;

export const PROMPT_GUIDELINES = [
  "Use ask_user_question for decisions and approvals that require user input; group independent decisions into one invocation.",
  "For a visual comparison, either set options[].generate.prompt to generate an image through the configured provider, or generate the first image with a separate image-generation tool and pass its path/URL/data URI in options[].image. Prefer a concise option.preview fallback for non-image hosts.",
  "Use stable stage and option ids when a review may span multiple rounds. Preserve reviewId, send the next round after a revision, and reset only the affected stage ids. Image generation is explicit and may consume provider quota; never add generate to an option unless the user asked for a generated visual.",
  "Treat a returned cancelled decision as an explicit user cancellation, not as approval. Treat a fallback decision as host unavailability and ask the questions in plain chat.",
];

function getPriorState(ctx: ExtensionContext, reviewId: string): ReviewState | undefined {
  return findReviewState(ctx.sessionManager.getBranch(), reviewId);
}

function initialAnswersFor(review: NormalizedReview, previous: ReviewState | undefined): ReviewAnswer[] {
  if (!previous) return [];
  const merged = mergeAnswers(previous.answers, review.stages);
  for (const stageId of review.resetStageIds) merged.delete(stageId);
  return [...merged.values()];
}

function initialSkippedStageIdsFor(review: NormalizedReview, previous: ReviewState | undefined): string[] {
  if (!previous?.skippedStageIds) return [];
  const valid = new Set(review.stages.filter((stage) => !stage.required).map((stage) => stage.id));
  return previous.skippedStageIds.filter((stageId) => valid.has(stageId) && !review.resetStageIds.includes(stageId));
}

/** Carry forward unchanged visual artifacts when a revision only regenerates selected stages. */
function restoreReviewArtifacts(review: NormalizedReview, previous: ReviewState | undefined): NormalizedReview {
  if (!previous) return review;
  const previousStages = new Map(previous.stages.map((stage) => [stage.id, stage]));
  const stages = review.stages.map((stage) => {
    const oldStage = previousStages.get(stage.id);
    if (!oldStage) return stage;
    const oldOptions = new Map(oldStage.options.map((option) => [option.id, option]));
    return {
      ...stage,
      options: stage.options.map((option) => {
        if (option.image || option.generate) return option;
        const oldImage = oldOptions.get(option.id)?.image;
        return oldImage ? { ...option, image: { ...oldImage } } : option;
      }),
    };
  });
  return {
    ...review,
    provider: review.provider ?? previous.provider,
    model: review.model ?? previous.model,
    imagePrompt: review.imagePrompt ?? previous.imagePrompt,
    generation: review.generation ?? previous.generation,
    stages,
  };
}

function resultDetails(result: ReviewResult, review: NormalizedReview): VisualReviewResultDetails {
  return {
    version: 1,
    kind: "visual-review",
    reviewId: result.reviewId,
    round: result.round,
    title: review.title,
    provider: review.provider,
    model: review.model,
    result,
  };
}

function textResult(result: ReviewResult, review: NormalizedReview): AgentToolResult<VisualReviewResultDetails> {
  return buildResponse(result, review) as AgentToolResult<VisualReviewResultDetails>;
}

function inputErrorResult(message: string): AgentToolResult<VisualReviewResultDetails> {
  return errorResponse(message) as AgentToolResult<VisualReviewResultDetails>;
}

function renderSummary(result: ReviewResult, review: NormalizedReview, theme: Theme): Text {
  const status =
    result.status === "completed"
      ? theme.fg("success", "approved")
      : result.status === "rejected"
        ? theme.fg("warning", "rejected")
        : result.status === "revision"
          ? theme.fg("accent", "revision requested")
          : result.status === "cancelled"
            ? theme.fg("warning", "cancelled")
            : theme.fg("muted", "fallback");
  const summary = `${theme.fg("accent", theme.bold(review.title ?? "Visual review"))} ${status}`;
  const answerCount = result.answers.length;
  return new Text(`${summary} (${answerCount} answer${answerCount === 1 ? "" : "s"})`, 0, 0);
}

function hasDialogUI(ctx: ExtensionContext): boolean {
  const ui = ctx.ui as Partial<ExtensionContext["ui"]>;
  return typeof ui.select === "function" && typeof ui.confirm === "function" && typeof ui.input === "function";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}

/**
 * Registers the compatibility tool. The package intentionally uses Pi's
 * built-in name so existing model workflows do not need to change. Disable or
 * remove the older ask_user_question registration when installing this package
 * if Pi reports a duplicate tool name.
 */
export default function registerVisualReview(pi: ExtensionAPI): void {
  pi.registerTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask User Question / Visual Review",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Ask for staged, image-aware user decisions and approvals",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: ReviewParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx): Promise<AgentToolResult<VisualReviewResultDetails>> {
      let review: NormalizedReview;
      let generatedImages: GeneratedImageReference[] = [];
      try {
        review = normalizeReview(rawParams as ReviewParams);
        validateReview(review);
      } catch (error) {
        return inputErrorResult(error instanceof Error ? error.message : String(error));
      }

      const previous = getPriorState(ctx, review.reviewId);
      review = restoreReviewArtifacts(review, previous);

      // Generation is deliberately explicit in the input contract. Existing image
      // references are left untouched; only options carrying `generate` are sent to
      // the configured provider. This keeps ordinary clarification questions free of
      // hidden network calls and provider quota consumption.
      try {
        const generated = await generateReviewImages(review, {
          cwd: ctx.cwd,
          signal: signal ?? ctx.signal,
          onProgress: ({ completed, total, option, image }) => onUpdate?.({
            content: [{ type: "text", text: `Generated image ${completed}/${total} for ${option.label}: ${image.path}` }],
            details: {
              version: 1,
              kind: "visual-review",
              reviewId: review.reviewId,
              round: review.round,
              title: review.title,
              provider: image.provider,
              model: image.model,
              progress: {
                completed,
                total,
                optionId: option.id,
                path: image.path,
                provider: image.provider,
                model: image.model,
                byteCount: image.byteCount,
              },
              result: {
                version: 1,
                reviewId: review.reviewId,
                round: review.round,
                status: "fallback",
                decision: "fallback",
                cancelled: false,
                answers: [],
                fallback: { reason: "no_ui", message: "Image generation is in progress." },
              },
            },
          }),
        });
        review = generated.review;
        generatedImages = generated.images.map((image) => {
          const match = review.stages.flatMap((stage) => stage.options
            .filter((option) => option.image?.path === image.path)
            .map((option) => ({ stageId: stage.id, optionId: option.id })))[0] ?? { stageId: "unknown", optionId: "unknown" };
          return {
            ...match,
            path: image.path,
            mimeType: image.mimeType,
            provider: image.provider,
            model: image.model,
            byteCount: image.byteCount,
            generated: true,
          };
        });
      } catch (error) {
        const message = error instanceof ImageGenerationError
          ? `Image generation failed (${error.code}): ${error.message}`
          : `Image generation failed: ${error instanceof Error ? error.message : String(error)}`;
        return errorResponse(message, review);
      }

      const initialAnswers = initialAnswersFor(review, previous);
      const initialSkippedStageIds = initialSkippedStageIdsFor(review, previous);

      if (previous && review.round <= previous.round) {
        // A model can accidentally reuse a completed round. It is safer to
        // require a later round than to silently discard prior answers, even
        // when resetStageIds is present.
        return textResult(
          {
            version: 1,
            reviewId: review.reviewId,
            round: review.round,
            status: "revision",
            decision: "revision",
            cancelled: false,
            answers: initialAnswers,
            ...(generatedImages.length > 0 ? { generatedImages } : {}),
            revision: {
              stageId: review.stages[0]?.id ?? "review",
              stageIndex: 0,
              feedback: "The next round must be greater than the persisted round, or affected stages must be listed in resetStageIds.",
              requestedRound: Math.max(review.round, previous.round + 1),
            },
          },
          review,
        );
      }

      let result: ReviewResult;
      if (!ctx.hasUI) {
        result = makeFallbackResult(review, "no_ui");
      } else if (ctx.mode === "rpc" && hasDialogUI(ctx)) {
        try {
          result = await runDialogReview(ctx, review, initialAnswers, initialSkippedStageIds);
        } catch (error) {
          if (isAbortError(error) || signal?.aborted || ctx.signal?.aborted) {
            result = {
              version: 1,
              reviewId: review.reviewId,
              round: review.round,
              status: "cancelled",
              decision: "cancel",
              cancelled: true,
              answers: initialAnswers,
              ...(generatedImages.length > 0 ? { generatedImages } : {}),
            };
          } else {
            result = makeFallbackResult(review, "rpc");
          }
        }
      } else if (ctx.mode === "tui") {
        try {
          const wizardResult = await runVisualReviewWizard(ctx, review, initialAnswers, initialSkippedStageIds);
          result = wizardResult ?? makeFallbackResult(review, "no_custom_ui");
        } catch (error) {
          if (isAbortError(error) || signal?.aborted || ctx.signal?.aborted) {
            result = {
              version: 1,
              reviewId: review.reviewId,
              round: review.round,
              status: "cancelled",
              decision: "cancel",
              cancelled: true,
              answers: initialAnswers,
              ...(generatedImages.length > 0 ? { generatedImages } : {}),
            };
          } else if (ctx.mode === "tui" && hasDialogUI(ctx)) {
            try {
              result = await runDialogReview(ctx, review, initialAnswers, initialSkippedStageIds);
            } catch {
              result = makeFallbackResult(review, "no_custom_ui");
            }
          } else {
            result = makeFallbackResult(review, "no_custom_ui");
          }
        }
      } else {
        result = makeFallbackResult(review, ctx.mode === "json" || ctx.mode === "print" ? "no_ui" : "no_custom_ui");
      }

      if (generatedImages.length > 0) result = { ...result, generatedImages };
      pi.appendEntry(REVIEW_STATE_CUSTOM_TYPE, makeReviewState(review, result.answers, result.status, result.skippedStageIds, result.generatedImages));
      return textResult(result, review);
    },
    renderCall(args, theme, _context) {
      const stages = (args as { stages?: unknown[]; questions?: unknown[] }).stages ?? (args as { questions?: unknown[] }).questions ?? [];
      const title = (args as { title?: string }).title;
      const text = `${theme.fg("toolTitle", theme.bold("ask_user_question "))}${theme.fg("muted", title ?? `${stages.length} stage${stages.length === 1 ? "" : "s"}`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const details = result.details as VisualReviewResultDetails | undefined;
      if (details?.result && details.title !== undefined) return renderSummary(details.result, { title: details.title } as NormalizedReview, theme);
      const textItem = result.content.find((item) => item.type === "text");
      return new Text(textItem?.type === "text" ? textItem.text : "", 0, 0);
    },
  });
}

export { fallbackText };
export { normalizeReview, ReviewParamsSchema, validateReview } from "../src/schema.ts";
export type { NormalizedReview, ReviewParams } from "../src/schema.ts";
export type { ReviewAnswer, ReviewResult, ReviewRevision, ReviewState } from "../src/state.ts";
export { buildResponse, errorResponse } from "../src/envelope.ts";
export { makeFallbackResult, runDialogReview } from "../src/fallback.ts";
export { runVisualReviewWizard } from "../src/tui.ts";
