import type { NormalizedGeneration, NormalizedOption, NormalizedReview, NormalizedStage } from "./schema.ts";
import { validateReview } from "./schema.ts";

/**
 * How a review ended, and - the reason `failed` is here - how it failed to start.
 *
 * A validation error or a dead image provider used to be reported as
 * `cancelled`, which the prompt guidelines tell the model to read as "the user
 * declined to answer". So a typo in the tool call was durably recorded as the
 * person refusing, and the model would say they had declined when nobody had.
 */
export type ReviewStatus = "completed" | "revision" | "rejected" | "cancelled" | "fallback" | "failed";
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
  notes?: string;
}

export interface ReviewRevision {
  stageId: string;
  stageIndex: number;
  feedback: string;
  requestedRound: number;
}

export interface GeneratedImageReference {
  stageId: string;
  optionId: string;
  path: string;
  mimeType: string;
  provider: string;
  model: string;
  byteCount: number;
  /** True when the image came from an explicit option.generate request. */
  generated?: boolean;
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
  /** Images created by explicit option.generate requests during this call. */
  generatedImages?: GeneratedImageReference[];
  globalNote?: string;
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
  /**
   * How many rounds were expected, when the model said so.
   *
   * It was validated on the way in and then never written here, so a resumed
   * round could never say "round 2 of 3" - the header silently degraded to
   * "round 2". Persisted alongside `round` so the two cannot disagree.
   */
  rounds?: number;
  /** Whether this review asked for its option images; off unless it said on. */
  images?: "off" | "on";
  /** Row density this review was opened with; comfortable unless it said compact. */
  density?: "comfortable" | "compact";
  /** Whether Enter resolves to the recommended option; off unless it said on. */
  autoResolve?: boolean;
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
  generatedImages?: GeneratedImageReference[];
  globalNote?: string;
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

function isGeneratedImageReference(value: unknown): value is GeneratedImageReference {
  if (!isRecord(value)) return false;
  return typeof value.stageId === "string" && typeof value.optionId === "string" &&
    typeof value.path === "string" && typeof value.mimeType === "string" &&
    typeof value.provider === "string" && typeof value.model === "string" &&
    Number.isInteger(value.byteCount) && (value.byteCount as number) > 0 &&
    (value.generated === undefined || typeof value.generated === "boolean");
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
    isOptionalString(value.notes) &&
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
    const answerText = typeof answer.answer === "string" ? answer.answer.trim() : undefined;
    const customText = answer.customText?.trim();
    const text = customText || answerText;
    return Boolean(text) && stage.allowOther && answerText === text && customText === text && answer.optionIds === undefined && answer.optionLabels === undefined && answer.optionValues === undefined;
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
  if (answer.kind !== "option" && answer.kind !== "multi") return false;
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
  if (answer.notes !== undefined && (!answer.notes.trim() || answer.notes.length > 2_000)) return false;
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
    (value.generatedImages !== undefined &&
      (!Array.isArray(value.generatedImages) || !value.generatedImages.every(isGeneratedImageReference))) ||
    !isOptionalString(value.globalNote) ||
    (value.status !== "completed" &&
      value.status !== "revision" &&
      value.status !== "rejected" &&
      value.status !== "cancelled" &&
      value.status !== "fallback" &&
      // `makeReviewState` accepts `failed` and the extension can build one, so
      // the reader has to know it too. Without this a persisted failure was an
      // entry that resume silently ignored.
      value.status !== "failed") ||
    typeof value.updatedAt !== "string" ||
    !isOptionalString(value.title) ||
    !isOptionalString(value.provider) ||
    !isOptionalString(value.model) ||
    !isOptionalString(value.imagePrompt) ||
    !isOptionalString(value.notes) ||
    // Rejected, not coerced. `images` and `density` go through `oneOf` and are
    // refused when they are not what they claim; `autoResolve` was turned into
    // a boolean with `value.autoResolve === true`, so a stale or hand-written
    // entry saying `autoResolve: "yes"` silently turned Ctrl+A *off* instead of
    // being refused.
    (value.autoResolve !== undefined && typeof value.autoResolve !== "boolean") ||
    (value.generation !== undefined && !isRecord(value.generation))
  ) {
    return false;
  }

  try {
    validateReview({
      reviewId: value.reviewId,
      round: value.round as number,
      ...(value.rounds === undefined ? {} : { rounds: value.rounds as number }),
      images: (value.images as "off" | "on" | undefined) ?? "off",
      density: (value.density as "comfortable" | "compact" | undefined) ?? "comfortable",
      ...(value.autoResolve === undefined ? {} : { autoResolve: value.autoResolve as boolean }),
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
  if (value.status === "completed" && unresolvedStages(
    {
      reviewId: value.reviewId,
      round: value.round as number,
      images: (value.images as "off" | "on" | undefined) ?? "off",
      density: (value.density as "comfortable" | "compact" | undefined) ?? "comfortable",
      resetStageIds: value.resetStageIds as string[],
      stages,
    },
    answers,
    skippedStageIds,
  ).length > 0) return false;
  const generatedImages = value.generatedImages as GeneratedImageReference[] | undefined;
  if (generatedImages) {
    const generatedKeys = new Set(generatedImages.map((image) => `${image.stageId}:${image.optionId}`));
    for (const image of generatedImages) {
      const stage = stages.find((candidate) => candidate.id === image.stageId);
      const option = stage?.options.find((candidate) => candidate.id === image.optionId);
      if (!stage || !option || !generatedKeys.has(`${image.stageId}:${image.optionId}`)) return false;
      if (image.generated && option.image?.path !== image.path) return false;
    }
  }
  return answers.every((answer) => {
    const index = stages.findIndex((stage) => stage.id === answer.stageId);
    return index >= 0 && !skipped.has(answer.stageId) && answerIsValid(answer, stages[index], index, true);
  });
}

/** Find the latest state entry for a review on the active session branch. */
/**
 * The presentation a resumed round keeps.
 *
 * A revision round arrives as a fresh review from the model, and it may leave
 * out the fields that describe how the review is *presented* rather than what it
 * asks. When it does, the mode the user was looking at is the mode they get -
 * and Ctrl+D still overrides either way, because this is where a round starts,
 * not a lock.
 *
 * This is the one place that rule lives. It used to be an `if` written twice
 * inside the extension's `execute()`, and the test for it *re-implemented* the
 * rule rather than calling it, so the carry-over could be deleted outright and
 * the suite would still pass. A test that copies the rule it is testing tests
 * itself; this one is called.
 */
export function carryOverPresentation<T extends { images?: "off" | "on"; density?: "comfortable" | "compact"; autoResolve?: boolean; rounds?: number; round?: number }>(
  review: T,
  previous: { images?: "off" | "on"; density?: "comfortable" | "compact"; autoResolve?: boolean; rounds?: number } | undefined,
): T {
  let next = review;
  if (next.images === "off" && previous?.images === "on") next = { ...next, images: "on" };
  if (next.density === "comfortable" && previous?.density === "compact") next = { ...next, density: "compact" };
  // Ctrl+A is a view choice in the same family as density, so it survives a
  // revision round the same way. Carried as a one-way: a round that asks for it
  // explicitly is honoured, and a round that does not inherits it.
  if (next.autoResolve !== true && previous?.autoResolve === true) next = { ...next, autoResolve: true };
  // The expected total, so a resumed round can still say "round 2 of 3" - but
  // only while it still bounds the round being carried. A review whose model
  // said `rounds: 3` and then asked for round 4 had a total of 3 carried into
  // it, and `validateReview` then refuses the combination (`rounds cannot be
  // less than round`). Nothing validated the result: the state was written into
  // the session and `isReviewState` skipped it on every later read, so that
  // round's answers, skips, note and generated images disappeared with no
  // error at all. Better to lose the "of 3" in the header than the round.
  const round = next.round ?? 1;
  if (next.rounds === undefined && previous?.rounds !== undefined && previous.rounds >= round) {
    next = { ...next, rounds: previous.rounds };
  }
  return next;
}

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
  generatedImages?: readonly GeneratedImageReference[],
  globalNote?: string,
): ReviewState {
  assertValidAnswerSet(review, answers);
  const skipped = normalizeSkippedStageIds(review, skippedStageIds, answers);
  if (status === "completed" && unresolvedStages(review, answers, skipped).length > 0) {
    throw new Error("Cannot persist a completed review while a stage is unresolved.");
  }
  if (status === "fallback" && answers.length > 0) {
    throw new Error("A fallback review cannot persist user answers.");
  }
  return {
    version: 1,
    reviewId: review.reviewId,
    round: review.round,
    ...(review.rounds === undefined ? {} : { rounds: review.rounds }),
    images: review.images,
    density: review.density,
    // Ctrl+A is a view choice like density, so a revision round should not
    // quietly drop it the way it used to.
    ...(review.autoResolve === undefined ? {} : { autoResolve: review.autoResolve }),
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
    ...(generatedImages && generatedImages.length > 0 ? { generatedImages: generatedImages.map((image) => ({ ...image })) } : {}),
    ...(globalNote ? { globalNote } : {}),
    status,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Merge answers by stable stage id. Stage indexes are repaired when a review
 * gains/reorders stages, so a revision does not discard otherwise valid work.
 */
/**
 * Previous answers that the revised review no longer supports.
 *
 * An answer is dropped silently when the stage it belonged to has changed
 * underneath it - an option renamed, a selection no longer valid - and the
 * reader sees an empty stage with no hint that they had answered it. The drop
 * is correct; the silence is not. The panel names these so a revised round can
 * say which stages were reconsidered rather than presenting them as new.
 */
export function droppedAnswers(previous: readonly ReviewAnswer[], stages: readonly NormalizedStage[]): ReviewAnswer[] {
  return previous.filter((answer, offset) => {
    const stage = stages.find((candidate) => candidate.id === answer.stageId);
    const index = stage ? stages.indexOf(stage) : offset;
    return !stage || !answerIsValid(answer, stage, index, true);
  });
}

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
  return stage.options.filter((o) => answer?.optionIds?.includes(o.id));
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

function answerEntries(answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[]): readonly (readonly [string, ReviewAnswer])[] {
  if (Array.isArray(answers)) {
    return (answers as readonly ReviewAnswer[]).map((answer) => {
      if (!isRecord(answer) || typeof answer.stageId !== "string") throw new Error("Every answer must identify a stage.");
      return [answer.stageId, answer as ReviewAnswer] as const;
    });
  }
  if (answers && typeof (answers as ReadonlyMap<string, ReviewAnswer>).entries === "function") {
    return [...(answers as ReadonlyMap<string, ReviewAnswer>).entries()];
  }
  throw new Error("Answers must be an array or a stage-id map.");
}

function answerMap(answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[]): ReadonlyMap<string, ReviewAnswer> {
  return new Map(answerEntries(answers));
}

function assertValidAnswerSet(
  review: Pick<NormalizedReview, "stages">,
  answers: ReadonlyMap<string, ReviewAnswer> | readonly ReviewAnswer[],
): void {
  const entries = answerEntries(answers);
  const seen = new Set<string>();
  for (const [stageId, answer] of entries) {
    if (seen.has(stageId)) throw new Error(`Duplicate answer for stage id: ${stageId}`);
    seen.add(stageId);
    const index = review.stages.findIndex((stage) => stage.id === stageId);
    if (index < 0) throw new Error(`Answer refers to an unknown stage id: ${stageId}`);
    if (!answer || typeof answer !== "object" || !isAnswerShape(answer) || !answerIsValid(answer, review.stages[index], index, true)) {
      throw new Error(`Answer for stage ${stageId} is not valid.`);
    }
  }
  for (const [stageId] of entries) {
    if (!review.stages.some((stage) => stage.id === stageId)) throw new Error(`Answer refers to an unknown stage id: ${stageId}`);
  }
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
  globalNote?: string,
): ReviewResult {
  assertValidAnswerSet(review, answers);
  const skipped = normalizeSkippedStageIds(review, skippedStageIds, answers);
  const ordered = orderedAnswers(review, answers);
  if (decision === "approve" && unresolvedStages(review, answers, skipped).length > 0) {
    throw new Error("Cannot approve a visual review before every stage is answered or explicitly skipped.");
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
    ...(globalNote ? { globalNote } : {}),
    ...(revision ? { revision: { ...revision } } : {}),
  };
}
