import type { NormalizedOption, NormalizedReview, NormalizedStage } from "./schema.ts";

export type ReviewStatus = "completed" | "revision" | "rejected" | "cancelled" | "fallback";
export type ReviewDecision = "approve" | "reject" | "revision" | "cancel" | "fallback";

export interface ReviewAnswer {
  stageId: string;
  stageIndex: number;
  kind: "option" | "multi" | "custom";
  optionIds?: string[];
  optionLabels?: string[];
  /** Optional machine-readable values supplied by the model, positionally aligned with optionIds. */
  optionValues?: (string | undefined)[];
  answer: string | null;
  customText?: string;
}

export interface ReviewRevision {
  stageId: string;
  stageIndex: number;
  feedback: string;
  requestedRound: number;
}

export interface ReviewResult {
  version: 1;
  reviewId: string;
  round: number;
  status: ReviewStatus;
  decision: ReviewDecision;
  cancelled: boolean;
  answers: ReviewAnswer[];
  revision?: ReviewRevision;
  fallback?: {
    reason: "no_ui" | "no_custom_ui" | "rpc";
    message: string;
  };
  error?: string;
}

export interface ReviewState {
  version: 1;
  reviewId: string;
  round: number;
  title?: string;
  provider?: string;
  model?: string;
  imagePrompt?: string;
  notes?: string;
  stages: NormalizedStage[];
  answers: ReviewAnswer[];
  status: ReviewStatus;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isReviewState(value: unknown): value is ReviewState {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.reviewId === "string" &&
    Number.isInteger(value.round) &&
    (value.round as number) >= 1 &&
    Array.isArray(value.stages) &&
    Array.isArray(value.answers) &&
    (value.status === "completed" ||
      value.status === "revision" ||
      value.status === "rejected" ||
      value.status === "cancelled" ||
      value.status === "fallback") &&
    typeof value.updatedAt === "string"
  );
}

/** Find the latest state entry for a review on the active session branch. */
export function findReviewState(entries: readonly unknown[], reviewId: string): ReviewState | undefined {
  let found: ReviewState | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "pi-visual-review-state") continue;
    const data = entry.data;
    if (isReviewState(data) && data.reviewId === reviewId) found = data;
  }
  return found;
}

export function makeReviewState(review: NormalizedReview, answers: readonly ReviewAnswer[], status: ReviewStatus): ReviewState {
  return {
    version: 1,
    reviewId: review.reviewId,
    round: review.round,
    title: review.title,
    provider: review.provider,
    model: review.model,
    imagePrompt: review.imagePrompt,
    notes: review.notes,
    stages: review.stages,
    answers: answers.map((answer) => ({
      ...answer,
      optionIds: answer.optionIds ? [...answer.optionIds] : undefined,
      optionLabels: answer.optionLabels ? [...answer.optionLabels] : undefined,
      optionValues: answer.optionValues ? [...answer.optionValues] : undefined,
    })),
    status,
    updatedAt: new Date().toISOString(),
  };
}

export function answersForStage(answers: readonly ReviewAnswer[], stageId: string): ReviewAnswer | undefined {
  return answers.find((answer) => answer.stageId === stageId);
}

function answerIsValid(answer: ReviewAnswer, stage: NormalizedStage, index: number): boolean {
  if (answer.stageId !== stage.id || answer.stageIndex !== index) return false;
  if (answer.kind === "custom") return Boolean(answer.customText?.trim() || answer.answer?.trim());
  const ids = answer.optionIds;
  if (!Array.isArray(ids) || ids.length === 0) return false;
  const validIds = new Set(stage.options.map((option) => option.id));
  if (ids.some((id) => !validIds.has(id))) return false;
  if (answer.kind === "option" && ids.length !== 1) return false;
  if (answer.kind === "multi" && !stage.multiSelect) return false;
  return true;
}

export function mergeAnswers(previous: readonly ReviewAnswer[], stages: readonly NormalizedStage[]): Map<string, ReviewAnswer> {
  const merged = new Map<string, ReviewAnswer>();
  for (const [index, stage] of stages.entries()) {
    const answer = previous.find((candidate) => candidate.stageId === stage.id);
    if (answer && answerIsValid(answer, stage, index)) {
      merged.set(stage.id, {
        ...answer,
        optionIds: answer.optionIds ? [...answer.optionIds] : undefined,
        optionLabels: answer.optionLabels ? [...answer.optionLabels] : undefined,
        optionValues: answer.optionValues ? [...answer.optionValues] : undefined,
      });
    }
  }
  return merged;
}

export function selectedOptions(stage: NormalizedStage, answer: ReviewAnswer | undefined): NormalizedOption[] {
  if (!answer?.optionIds?.length) return [];
  const ids = new Set(answer.optionIds);
  return stage.options.filter((option) => ids.has(option.id));
}

export function makeOptionAnswer(stage: NormalizedStage, stageIndex: number, options: readonly NormalizedOption[]): ReviewAnswer {
  return {
    stageId: stage.id,
    stageIndex,
    kind: stage.multiSelect ? "multi" : "option",
    optionIds: options.map((option) => option.id),
    optionLabels: options.map((option) => option.label),
    optionValues: options.map((option) => option.value),
    answer: options.map((option) => option.label).join(", ") || null,
  };
}

export function makeCustomAnswer(stage: NormalizedStage, stageIndex: number, text: string): ReviewAnswer {
  const trimmed = text.trim();
  return {
    stageId: stage.id,
    stageIndex,
    kind: "custom",
    answer: trimmed || null,
    customText: trimmed || undefined,
  };
}

export function resultFromState(state: ReviewState, decision: ReviewDecision, revision?: ReviewRevision): ReviewResult {
  const status: ReviewStatus =
    decision === "approve"
      ? "completed"
      : decision === "reject"
        ? "rejected"
        : decision === "revision"
          ? "revision"
          : decision === "cancel"
            ? "cancelled"
            : "fallback";
  return {
    version: 1,
    reviewId: state.reviewId,
    round: state.round,
    status,
    decision,
    cancelled: decision === "cancel",
    answers: state.answers,
    ...(revision ? { revision } : {}),
  };
}
