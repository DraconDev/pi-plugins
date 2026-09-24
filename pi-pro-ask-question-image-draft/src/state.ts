import type { NormalizedGeneration, NormalizedOption, NormalizedReview, NormalizedStage } from "./schema.ts";
import { validateReview } from "./schema.ts";

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
  generation?: NormalizedGeneration;
  resetStageIds: string[];
  stages: NormalizedStage[];
  answers: ReviewAnswer[];
  status: ReviewStatus;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isAnswerShape(value: unknown): value is ReviewAnswer {
  if (!isRecord(value)) return false;
  return (
    typeof value.stageId === "string" &&
    Number.isInteger(value.stageIndex) &&
    (value.stageIndex as number) >= 0 &&
    (value.kind === "option" || value.kind === "multi" || value.kind === "custom") &&
    (value.answer === null || typeof value.answer === "string") &&
    isOptionalString(value.customText) &&
    (value.optionIds === undefined || isStringArray(value.optionIds)) &&
    (value.optionLabels === undefined || isStringArray(value.optionLabels)) &&
    (value.optionValues === undefined ||
      (Array.isArray(value.optionValues) && value.optionValues.every((item) => item === undefined || typeof item === "string")))
  );
}

function answerIsValid(answer: ReviewAnswer, stage: NormalizedStage, index: number, allowIndexMismatch = false): boolean {
  if (answer.stageId !== stage.id || (!allowIndexMismatch && answer.stageIndex !== index)) return false;
  if (answer.stageIndex < 0) return false;

  if (answer.kind === "custom") {
    const text = answer.customText?.trim() || answer.answer?.trim();
    return Boolean(text) && answer.optionIds === undefined && answer.optionLabels === undefined && answer.optionValues === undefined;
  }

  const ids = answer.optionIds;
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) return false;
  const optionsById = new Map(stage.options.map((option) => [option.id, option]));
  if (ids.some((id) => !optionsById.has(id))) return false;
  if (answer.kind === "option" && (ids.length !== 1 || stage.multiSelect)) return false;
  if (answer.kind === "multi" && !stage.multiSelect) return false;
  if (answer.optionLabels !== undefined) {
    if (answer.optionLabels.length !== ids.length) return false;
    if (ids.some((id, i) => answer.optionLabels?.[i] !== optionsById.get(id)?.label)) return false;
  }
  if (answer.optionValues !== undefined) {
    if (answer.optionValues.length !== ids.length) return false;
    if (ids.some((id, i) => answer.optionValues?.[i] !== optionsById.get(id)?.value)) return false;
  }
  if (answer.kind === "option" && typeof answer.answer === "string" && answer.answer !== optionsById.get(ids[0])?.label) {
    return false;
  }
  if (answer.kind === "multi" && typeof answer.answer === "string") {
    const expected = ids.map((id) => optionsById.get(id)?.label).join(", ");
    if (answer.answer !== expected) return false;
  }
  return true;
}

export function isUsableAnswer(answer: ReviewAnswer | undefined, stage: NormalizedStage, index: number, allowIndexMismatch = false): boolean {
  return Boolean(answer && answerIsValid(answer, stage, index, allowIndexMismatch));
}

export function isReviewState(value: unknown): value is ReviewState {
  if (!isRecord(value)) return false;
  if (
    value.version !== 1 ||
    typeof value.reviewId !== "string" ||
    !Number.isInteger(value.round) ||
    (value.round as number) < 1 ||
    !Array.isArray(value.stages) ||
    !Array.isArray(value.answers) ||
    !value.answers.every(isAnswerShape) ||
    !isStringArray(value.resetStageIds) ||
    (value.status !== "completed" &&
      value.status !== "revision" &&
      value.status !== "rejected" &&
      value.status !== "cancelled" &&
      value.status !== "fallback") ||
    typeof value.updatedAt !== "string" ||
    !isOptionalString(value.title) ||
    !isOptionalString(value.provider) ||
    !isOptionalString(value.model) ||
    !isOptionalString(value.imagePrompt) ||
    !isOptionalString(value.notes)
  ) {
    return false;
  }

  try {
    validateReview({
      reviewId: value.reviewId,
      round: value.round as number,
      title: value.title as string | undefined,
      provider: value.provider as string | undefined,
      model: value.model as string | undefined,
      imagePrompt: value.imagePrompt as string | undefined,
      notes: value.notes as string | undefined,
      generation: value.generation as NormalizedGeneration | undefined,
      resetStageIds: value.resetStageIds as string[],
      stages: value.stages as NormalizedStage[],
    });
  } catch {
    return false;
  }

  const stages = value.stages as NormalizedStage[];
  const answers = value.answers as ReviewAnswer[];
  return answers.every((answer) => {
    const index = stages.findIndex((stage) => stage.id === answer.stageId);
    return index >= 0 && answerIsValid(answer, stages[index], index, true);
  });
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

function cloneAnswer(answer: ReviewAnswer, stageIndex = answer.stageIndex): ReviewAnswer {
  return {
    ...answer,
    stageIndex,
    optionIds: answer.optionIds ? [...answer.optionIds] : undefined,
    optionLabels: answer.optionLabels ? [...answer.optionLabels] : undefined,
    optionValues: answer.optionValues ? [...answer.optionValues] : undefined,
  };
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
    generation: review.generation,
    resetStageIds: [...review.resetStageIds],
    stages: review.stages,
    answers: answers.map((answer) => cloneAnswer(answer)),
    status,
    updatedAt: new Date().toISOString(),
  };
}

export function answersForStage(answers: readonly ReviewAnswer[], stageId: string): ReviewAnswer | undefined {
  return answers.find((answer) => answer.stageId === stageId);
}

/**
 * Merge answers by stable stage id. Stage indexes are repaired when a review
 * gains/reorders stages, so a revision does not discard otherwise valid work.
 */
export function mergeAnswers(previous: readonly ReviewAnswer[], stages: readonly NormalizedStage[]): Map<string, ReviewAnswer> {
  const merged = new Map<string, ReviewAnswer>();
  for (const [index, stage] of stages.entries()) {
    const answer = previous.find((candidate) => candidate.stageId === stage.id);
    if (answer && answerIsValid(answer, stage, index, true)) {
      merged.set(stage.id, cloneAnswer(answer, index));
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

export function missingRequiredStages(review: NormalizedReview, answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[]): NormalizedStage[] {
  const byId = answers instanceof Map ? answers : new Map(answers.map((answer) => [answer.stageId, answer]));
  return review.stages.filter((stage, index) => stage.required && !isUsableAnswer(byId.get(stage.id), stage, index, true));
}

export function hasRequiredAnswers(review: NormalizedReview, answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[]): boolean {
  return missingRequiredStages(review, answers).length === 0;
}

export function orderedAnswers(review: NormalizedReview, answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[]): ReviewAnswer[] {
  const byId = answers instanceof Map ? answers : new Map(answers.map((answer) => [answer.stageId, answer]));
  return review.stages.flatMap((stage, index) => {
    const answer = byId.get(stage.id);
    return answer && isUsableAnswer(answer, stage, index, true) ? [cloneAnswer(answer, index)] : [];
  });
}

/** Construct a result while enforcing the approval gate at the boundary. */
export function makeReviewResult(
  review: NormalizedReview,
  decision: Exclude<ReviewDecision, "fallback">,
  answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[],
  revision?: ReviewRevision,
): ReviewResult {
  const ordered = orderedAnswers(review, answers);
  if (decision === "approve" && !hasRequiredAnswers(review, answers)) {
    throw new Error("Cannot approve a visual review before every required stage has an answer.");
  }
  const status: ReviewStatus =
    decision === "approve"
      ? "completed"
      : decision === "reject"
        ? "rejected"
        : decision === "revision"
          ? "revision"
          : "cancelled";
  if (decision === "revision" && !revision) throw new Error("A revision result requires revision details.");
  return {
    version: 1,
    reviewId: review.reviewId,
    round: review.round,
    status,
    decision,
    cancelled: decision === "cancel",
    answers: ordered,
    ...(revision ? { revision: { ...revision } } : {}),
  };
}

export function resultFromState(state: ReviewState, decision: ReviewDecision, revision?: ReviewRevision): ReviewResult {
  if (decision === "fallback") {
    return {
      version: 1,
      reviewId: state.reviewId,
      round: state.round,
      status: "fallback",
      decision,
      cancelled: false,
      answers: [],
    };
  }
  const review: NormalizedReview = {
    reviewId: state.reviewId,
    round: state.round,
    title: state.title,
    provider: state.provider,
    model: state.model,
    imagePrompt: state.imagePrompt,
    notes: state.notes,
    generation: state.generation,
    resetStageIds: state.resetStageIds,
    stages: state.stages,
  };
  return makeReviewResult(review, decision, state.answers, revision);
}
