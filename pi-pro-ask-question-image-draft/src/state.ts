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
  /** Optional stages explicitly skipped by the user. */
  skippedStageIds?: string[];
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
  /** Optional stages explicitly skipped by the user. */
  skippedStageIds?: string[];
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
    return Boolean(text) && stage.allowOther && answer.optionIds === undefined && answer.optionLabels === undefined && answer.optionValues === undefined;
  }

  // Option answers are always rendered as a non-empty label. Keeping this
  // invariant here prevents a malformed persisted answer from satisfying the
  // approval gate merely because its option id happens to exist.
  if (typeof answer.answer !== "string" || !answer.answer.trim()) return false;
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

/** Return true when a stage has a usable answer, regardless of whether it is required. */
export function isStageAnswered(stage: NormalizedStage, index: number, answer: ReviewAnswer | undefined): boolean {
  return isUsableAnswer(answer, stage, index, true);
}

/** Return stages that still need either a valid answer or an explicit skip. */
export function unresolvedStages(
  review: NormalizedReview,
  answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[],
  skippedStageIds: readonly string[] = [],
): NormalizedStage[] {
  const byId = answerMap(answers);
  const skipped = new Set(skippedStageIds);
  return review.stages.filter((stage, index) => {
    return !skipped.has(stage.id) && !isStageAnswered(stage, index, byId.get(stage.id));
  });
}

/** Return the first required stage that cannot yet be approved. */
export function firstMissingRequiredStage(
  review: NormalizedReview,
  answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[],
): NormalizedStage | undefined {
  return missingRequiredStages(review, answers)[0];
}

/** Return the first stage that must be answered or explicitly skipped. */
export function firstUnresolvedStage(
  review: NormalizedReview,
  answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[],
  skippedStageIds: readonly string[] = [],
): NormalizedStage | undefined {
  return unresolvedStages(review, answers, skippedStageIds)[0];
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
    (value.skippedStageIds !== undefined && !isStringArray(value.skippedStageIds)) ||
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
    !isOptionalString(value.notes) ||
    (value.generation !== undefined && !isRecord(value.generation))
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
  try {
    assertValidAnswerSet({ stages } as NormalizedReview, answers);
  } catch {
    return false;
  }
  const skippedStageIds = (value.skippedStageIds as string[] | undefined) ?? [];
  const skipped = new Set(skippedStageIds);
  if (new Set(skippedStageIds).size !== skippedStageIds.length) return false;
  if (skippedStageIds.some((id) => {
    const stage = stages.find((candidate) => candidate.id === id);
    return !stage || stage.required || answers.some((answer) => answer.stageId === id);
  })) return false;
  if (value.status === "completed" && missingRequiredStages(
    { reviewId: value.reviewId, round: value.round as number, resetStageIds: value.resetStageIds as string[], stages },
    answers,
  ).length > 0) return false;
  return answers.every((answer) => {
    const index = stages.findIndex((stage) => stage.id === answer.stageId);
    return index >= 0 && !skipped.has(answer.stageId) && answerIsValid(answer, stages[index], index, true);
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

export function makeReviewState(
  review: NormalizedReview,
  answers: readonly ReviewAnswer[],
  status: ReviewStatus,
  skippedStageIds: readonly string[] = [],
): ReviewState {
  assertValidAnswerSet(review, answers);
  const skipped = normalizeSkippedStageIds(review, skippedStageIds, answers);
  if (status === "completed" && missingRequiredStages(review, answers).length > 0) {
    throw new Error("Cannot persist a completed review while a required stage is unresolved.");
  }
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
    answers: orderedAnswers(review, answers),
    ...(skipped.length > 0 ? { skippedStageIds: skipped } : {}),
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
  if (options.length === 0) throw new Error("An option answer must contain at least one option.");
  const selectedIds = new Set(options.map((option) => option.id));
  if (selectedIds.size !== options.length || options.some((option) => !stage.options.some((candidate) => candidate.id === option.id))) {
    throw new Error("An option answer contains an unknown or duplicate option id.");
  }
  if (!stage.multiSelect && options.length !== 1) throw new Error("A single-select stage accepts exactly one option.");
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
  if (!stage.allowOther) throw new Error("This stage does not allow custom answers.");
  const trimmed = text.trim();
  if (!trimmed) throw new Error("A custom answer cannot be empty.");
  return {
    stageId: stage.id,
    stageIndex,
    kind: "custom",
    answer: trimmed || null,
    customText: trimmed || undefined,
  };
}

function answerMap(answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[]): ReadonlyMap<string, ReviewAnswer> {
  if (Array.isArray(answers)) {
    return new Map((answers as readonly ReviewAnswer[]).map((answer) => [answer.stageId, answer]));
  }
  return answers as ReadonlyMap<string, ReviewAnswer>;
}

function normalizeSkippedStageIds(
  review: NormalizedReview,
  skippedStageIds: readonly string[],
  answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[],
): string[] {
  const byId = answerMap(answers);
  const seen = new Set<string>();
  for (const id of skippedStageIds) {
    const stage = review.stages.find((candidate) => candidate.id === id);
    if (!stage) throw new Error(`Cannot skip unknown stage id: ${id}`);
    if (stage.required) throw new Error(`Required stage cannot be skipped: ${id}`);
    if (byId.has(id)) throw new Error(`A stage cannot be both answered and skipped: ${id}`);
    if (!seen.has(id)) seen.add(id);
  }
  return [...seen];
}

export function missingRequiredStages(review: NormalizedReview, answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[]): NormalizedStage[] {
  const byId = answerMap(answers);
  return review.stages.filter((stage, index) => stage.required && !isUsableAnswer(byId.get(stage.id), stage, index, true));
}

export function hasRequiredAnswers(review: NormalizedReview, answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[]): boolean {
  return missingRequiredStages(review, answers).length === 0;
}

export function orderedAnswers(review: NormalizedReview, answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[]): ReviewAnswer[] {
  const byId = answerMap(answers);
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
  skippedStageIds: readonly string[] = [],
): ReviewResult {
  const skipped = normalizeSkippedStageIds(review, skippedStageIds, answers);
  const ordered = orderedAnswers(review, answers);
  if (decision === "approve" && !hasRequiredAnswers(review, answers)) {
    throw new Error("Cannot approve a visual review before every required stage has an answer.");
  }
  if (decision === "revision") {
    if (!revision) throw new Error("A revision result requires revision details.");
    const stageIndex = review.stages.findIndex((stage) => stage.id === revision.stageId);
    if (stageIndex < 0 || revision.stageIndex !== stageIndex) {
      throw new Error("Revision details must identify a stage in the current review.");
    }
    if (!revision.feedback.trim()) throw new Error("Revision feedback cannot be empty.");
    if (!Number.isInteger(revision.requestedRound) || revision.requestedRound <= review.round) {
      throw new Error("A revision must request a later round.");
    }
  } else if (revision) {
    throw new Error("Only a revision result may include revision details.");
  }
  const status: ReviewStatus =
    decision === "approve"
      ? "completed"
      : decision === "reject"
        ? "rejected"
        : decision === "revision"
          ? "revision"
          : "cancelled";
  return {
    version: 1,
    reviewId: review.reviewId,
    round: review.round,
    status,
    decision,
    cancelled: decision === "cancel",
    answers: ordered,
    ...(skipped.length > 0 ? { skippedStageIds: skipped } : {}),
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
  return makeReviewResult(review, decision, state.answers, revision, state.skippedStageIds);
}
