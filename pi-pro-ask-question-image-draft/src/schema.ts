import { randomUUID } from "node:crypto";

import { Type, type Static } from "typebox";

/** Limits keep a review usable in a terminal and prevent accidental unbounded tool calls. */
export const MAX_STAGES = 6;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_HEADER_LENGTH = 32;
export const MAX_LABEL_LENGTH = 80;
export const MAX_STAGE_ID_LENGTH = 64;
export const MAX_IMAGE_DATA_LENGTH = 30 * 1024 * 1024;

/** Labels owned by the wizard. Authors must use a different label for real options. */
export const RESERVED_LABELS = [
  "Other",
  "Type something.",
  "Next",
  "Done selecting",
  "Skip stage",
  "Request revision",
  "Approve",
  "Reject",
  "Edit answers",
  "Review & approve",
] as const;

/**
 * An image is intentionally provider-neutral. The model normally creates it
 * with a separate image-generation tool (Agnes, Codex, Meta, etc.) and passes
 * the returned local path or URL here.
 */
export const ImageReferenceSchema = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "Local image path returned by an image-generation tool." })),
    url: Type.Optional(Type.String({ description: "Optional remote image URL. The file is downloaded for inline preview." })),
    dataUri: Type.Optional(Type.String({ description: "Optional base64 image data URI (data:image/...;base64,...)." })),
    mimeType: Type.Optional(Type.String({ description: "Optional MIME type, for example image/png." })),
    alt: Type.Optional(Type.String({ description: "Accessible description of the image." })),
  },
  { description: "A local path, remote URL, or data URI for one generated image." },
);

/** A string shorthand is convenient when a generator returns just a path. */
export const ImageInputSchema = Type.Union(
  [
    Type.String({ description: "Local path, HTTPS URL, file URL, or data URI." }),
    ImageReferenceSchema,
  ],
  { description: "Image reference. Prefer the object form when adding alt text or a MIME type." },
);

const PreviewSchema = Type.String({
  maxLength: 20_000,
  description:
    "Markdown or plain-text fallback shown when the image cannot be displayed. Keep it concise; do not use ASCII art when an image reference is available.",
});

export const ReviewOptionSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: MAX_STAGE_ID_LENGTH, description: "Stable option identifier." })),
  label: Type.String({ maxLength: MAX_LABEL_LENGTH, description: "Concise option label (1-5 words is recommended)." }),
  description: Type.Optional(Type.String({ maxLength: 4_000, description: "What this option means and its trade-offs." })),
  value: Type.Optional(Type.String({ maxLength: 2_000, description: "Optional machine-readable value to return when this option is selected." })),
  preview: Type.Optional(PreviewSchema),
  image: Type.Optional(ImageInputSchema),
});

export const ReviewStageSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: MAX_STAGE_ID_LENGTH, description: "Stable stage identifier for revision/resume." })),
  kind: Type.Optional(
    Type.Union([Type.Literal("choice"), Type.Literal("draft")], {
      description: "Presentation hint. Draft stages are intended for comparing generated visual drafts.",
    }),
  ),
  header: Type.String({ maxLength: MAX_HEADER_LENGTH, description: "Short stage title shown in the wizard tab bar." }),
  prompt: Type.String({ maxLength: 20_000, description: "The complete question or review instruction for this stage." }),
  description: Type.Optional(Type.String({ maxLength: 10_000, description: "Optional context shown below the prompt." })),
  options: Type.Array(ReviewOptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: `${MIN_OPTIONS}-${MAX_OPTIONS} choices for this stage.`,
  }),
  allowOther: Type.Optional(Type.Boolean({ description: "Append a custom text answer row (default: true)." })),
  allowRevision: Type.Optional(Type.Boolean({ description: "Append a revision request row (default: true for stages)." })),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option (default: false)." })),
  required: Type.Optional(Type.Boolean({ description: "Require an answer before the review can be approved (default: true)." })),
  imagePrompt: Type.Optional(Type.String({ maxLength: 20_000, description: "Prompt or notes for generating this stage's images on a later round." })),
});

const QuestionsSchema = Type.Array(
  Type.Object({
    question: Type.String({ maxLength: 20_000, description: "The complete question to ask." }),
    header: Type.Optional(Type.String({ maxLength: MAX_HEADER_LENGTH, description: "Short tab label." })),
    kind: Type.Optional(Type.Union([Type.Literal("choice"), Type.Literal("draft")])),
    options: Type.Array(ReviewOptionSchema, { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS }),
    multiSelect: Type.Optional(Type.Boolean()),
    allowOther: Type.Optional(Type.Boolean()),
    required: Type.Optional(Type.Boolean()),
    imagePrompt: Type.Optional(Type.String({ maxLength: 20_000 })),
  }),
  { minItems: 1, maxItems: 4, description: "Legacy-compatible simple question stages." },
);

const StagesSchema = Type.Array(ReviewStageSchema, {
  minItems: 1,
  maxItems: MAX_STAGES,
  description: "Ordered review stages. A stage may contain image-backed options.",
});

/** Optional metadata describing how the model should generate a later image revision. */
export const GenerationSpecSchema = Type.Object({
  prompt: Type.Optional(Type.String({ maxLength: 20_000, description: "Prompt for a future image-generation call." })),
  provider: Type.Optional(Type.String({ maxLength: 100, description: "Provider name, for example agnes." })),
  model: Type.Optional(Type.String({ maxLength: 200, description: "Provider-specific image model id." })),
  negativePrompt: Type.Optional(Type.String({ maxLength: 20_000 })),
  size: Type.Optional(Type.String({ maxLength: 100 })),
});

export const ReviewParamsSchema = Type.Object({
  stages: Type.Optional(StagesSchema),
  questions: Type.Optional(QuestionsSchema),
  title: Type.Optional(Type.String({ maxLength: 200, description: "Optional title for the review wizard." })),
  reviewId: Type.Optional(Type.String({ maxLength: 200, description: "Stable id used to resume a review after a revision." })),
  round: Type.Optional(Type.Integer({ minimum: 1, description: "Revision round, starting at 1." })),
  resetStageIds: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_STAGE_ID_LENGTH }), {
      maxItems: MAX_STAGES,
      description: "Stage ids whose previous answers should be cleared before opening the wizard.",
    }),
  ),
  notes: Type.Optional(Type.String({ maxLength: 20_000, description: "Optional notes shown on the final review tab." })),
  provider: Type.Optional(Type.String({ maxLength: 100, description: "Image provider metadata to carry into the next generation request." })),
  model: Type.Optional(Type.String({ maxLength: 200, description: "Image model metadata to carry into the next generation request." })),
  imagePrompt: Type.Optional(Type.String({ maxLength: 20_000, description: "Prompt for the first/next image generation pass." })),
  generation: Type.Optional(GenerationSpecSchema),
});

export type ImageReference = Static<typeof ImageReferenceSchema>;
export type ImageInput = Static<typeof ImageInputSchema>;
export type ReviewOption = Static<typeof ReviewOptionSchema>;
export type ReviewStage = Static<typeof ReviewStageSchema>;
export type ReviewParams = Static<typeof ReviewParamsSchema>;
export type GenerationSpec = Static<typeof GenerationSpecSchema>;

export interface NormalizedOption {
  id: string;
  label: string;
  description?: string;
  value?: string;
  preview?: string;
  image?: ImageReference;
}

export interface NormalizedStage {
  id: string;
  kind: "choice" | "draft";
  header: string;
  prompt: string;
  description?: string;
  options: NormalizedOption[];
  allowOther: boolean;
  allowRevision: boolean;
  multiSelect: boolean;
  required: boolean;
  imagePrompt?: string;
}

export interface NormalizedGeneration {
  prompt?: string;
  provider?: string;
  model?: string;
  negativePrompt?: string;
  size?: string;
}

export interface NormalizedReview {
  title?: string;
  stages: NormalizedStage[];
  reviewId: string;
  round: number;
  resetStageIds: string[];
  notes?: string;
  provider?: string;
  model?: string;
  imagePrompt?: string;
  generation?: NormalizedGeneration;
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = normalizeText(value).trim();
  return text || undefined;
}

function uniqueId(prefix: string, index: number, used: Set<string>): string {
  const base = `${prefix}-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function isDataUri(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function normalizeImage(image: ImageInput | undefined): ImageReference | undefined {
  if (image === undefined) return undefined;

  if (typeof image === "string") {
    const value = image.trim();
    if (!value) return undefined;
    if (isDataUri(value)) return { dataUri: value };
    if (/^https?:\/\//i.test(value)) return { url: value };
    // Keep file URLs in the path field so the loader can resolve them locally.
    if (/^file:\/\//i.test(value)) return { path: value };
    return { path: value };
  }

  const out: ImageReference = {};
  const path = optionalText(image.path);
  const url = optionalText(image.url);
  const dataUri = optionalText(image.dataUri);
  const mimeType = optionalText(image.mimeType)?.toLowerCase().split(";", 1)[0];
  const alt = optionalText(image.alt);
  if (path) out.path = path;
  if (url) out.url = url;
  if (dataUri) out.dataUri = dataUri;
  if (mimeType) out.mimeType = mimeType;
  if (alt) out.alt = alt;
  return Object.keys(out).length > 0 ? out : undefined;
}

function isReservedLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return (RESERVED_LABELS as readonly string[]).some((reserved) => reserved.toLowerCase() === normalized);
}

interface RawStage {
  id?: string;
  kind?: "choice" | "draft";
  header: string;
  prompt: string;
  description?: string;
  options: readonly ReviewOption[];
  allowOther?: boolean;
  allowRevision?: boolean;
  multiSelect?: boolean;
  required?: boolean;
  imagePrompt?: string;
}

function rawStageFromQuestion(question: Static<typeof QuestionsSchema>[number], index: number): RawStage {
  return {
    id: `question-${index + 1}`,
    kind: question.kind,
    header: question.header ?? `Q${index + 1}`,
    prompt: question.question,
    options: question.options,
    allowOther: question.allowOther,
    // Legacy calls do not unexpectedly grow a revision row. New stage calls do.
    allowRevision: false,
    multiSelect: question.multiSelect,
    required: question.required,
    imagePrompt: question.imagePrompt,
  };
}

function normalizeGeneration(params: ReviewParams): NormalizedGeneration | undefined {
  const generation = params.generation;
  const out: NormalizedGeneration = {
    prompt: optionalText(generation?.prompt),
    provider: optionalText(generation?.provider),
    model: optionalText(generation?.model),
    negativePrompt: optionalText(generation?.negativePrompt),
    size: optionalText(generation?.size),
  };
  const hasValue = Object.values(out).some((value) => value !== undefined);
  return hasValue ? out : undefined;
}

export function normalizeReview(params: ReviewParams, now = Date.now()): NormalizedReview {
  const suppliedStages = params.stages as readonly RawStage[] | undefined;
  const rawStages: readonly RawStage[] = suppliedStages?.length
    ? suppliedStages
    : (params.questions ?? []).map(rawStageFromQuestion);

  if (!rawStages.length) {
    throw new Error("Provide at least one stage (or a legacy questions array).");
  }

  const usedStageIds = new Set<string>();
  const stages = rawStages.map((stage, stageIndex) => {
    const requestedId = stage.id?.trim();
    const id = requestedId || uniqueId("stage", stageIndex, usedStageIds);
    if (usedStageIds.has(id) && requestedId) {
      throw new Error(`Duplicate stage id: ${id}`);
    }
    usedStageIds.add(id);

    const usedOptionIds = new Set<string>();
    const options = stage.options.map((option, optionIndex) => {
      const requestedOptionId = option.id?.trim();
      const optionId = requestedOptionId || uniqueId(`${id}-option`, optionIndex, usedOptionIds);
      if (usedOptionIds.has(optionId) && requestedOptionId) {
        throw new Error(`Duplicate option id in stage ${id}: ${optionId}`);
      }
      usedOptionIds.add(optionId);
      return {
        id: optionId,
        label: normalizeText(option.label).trim(),
        description: optionalText(option.description),
        value: optionalText(option.value),
        preview: option.preview === undefined ? undefined : normalizeText(option.preview),
        image: normalizeImage(option.image),
      } satisfies NormalizedOption;
    });

    return {
      id,
      kind: stage.kind === "draft" ? "draft" : "choice",
      header: normalizeText(stage.header).trim(),
      prompt: normalizeText(stage.prompt).trim(),
      description: optionalText(stage.description),
      options,
      allowOther: stage.allowOther !== false,
      allowRevision: suppliedStages ? stage.allowRevision !== false : stage.allowRevision === true,
      multiSelect: stage.multiSelect === true,
      required: stage.required !== false,
      imagePrompt: optionalText(stage.imagePrompt),
    } satisfies NormalizedStage;
  });

  const generation = normalizeGeneration(params);
  const provider = optionalText(params.provider) ?? generation?.provider;
  const model = optionalText(params.model) ?? generation?.model;
  const imagePrompt = optionalText(params.imagePrompt) ?? generation?.prompt;

  return {
    title: optionalText(params.title),
    stages,
    reviewId: optionalText(params.reviewId) || `review-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
    round: Math.max(1, Math.floor(params.round ?? 1)),
    resetStageIds: [...new Set((params.resetStageIds ?? []).map((id) => id.trim()).filter(Boolean))],
    notes: optionalText(params.notes),
    provider,
    model,
    imagePrompt,
    generation,
  };
}

function validateImage(image: ImageReference, optionId: string): void {
  if (!image.path && !image.url && !image.dataUri) {
    throw new Error(`Image on option ${optionId} needs path, url, or dataUri.`);
  }
  if (image.path && image.path.length > 4_000) {
    throw new Error(`Image path on option ${optionId} is too long.`);
  }
  if (image.url && !/^(https?|file):\/\//i.test(image.url)) {
    throw new Error(`Image URL on option ${optionId} must use http(s) or file.`);
  }
  if (image.dataUri) {
    if (!isDataUri(image.dataUri)) throw new Error(`Image data URI on option ${optionId} is malformed.`);
    if (image.dataUri.length > MAX_IMAGE_DATA_LENGTH) throw new Error(`Image data URI on option ${optionId} is too large.`);
  }
  if (image.mimeType && !image.mimeType.startsWith("image/")) {
    throw new Error(`Image MIME type on option ${optionId} must start with image/.`);
  }
  if (image.alt && image.alt.length > 2_000) {
    throw new Error(`Image alt text on option ${optionId} is too long.`);
  }
}

export function validateReview(review: NormalizedReview): void {
  if (review.stages.length < 1 || review.stages.length > MAX_STAGES) {
    throw new Error(`A review must contain 1-${MAX_STAGES} stages.`);
  }
  if (!review.reviewId || review.reviewId.length > 200) {
    throw new Error("reviewId must be a non-empty string of at most 200 characters.");
  }
  if (!Number.isInteger(review.round) || review.round < 1) {
    throw new Error("round must be a positive integer.");
  }
  if (review.resetStageIds.length > MAX_STAGES) {
    throw new Error(`A review may reset at most ${MAX_STAGES} stages.`);
  }
  if (review.title && review.title.length > 200) throw new Error("title is too long.");
  if (review.notes && review.notes.length > 20_000) throw new Error("notes is too long.");
  if (review.provider && review.provider.length > 100) throw new Error("provider is too long.");
  if (review.model && review.model.length > 200) throw new Error("model is too long.");

  const stageIds = new Set<string>();
  for (const stage of review.stages) {
    if (!stage.id || stage.id.length > MAX_STAGE_ID_LENGTH || stageIds.has(stage.id)) {
      throw new Error(`Stage ids must be unique and non-empty: ${stage.id}`);
    }
    stageIds.add(stage.id);
    if (!stage.header || stage.header.length > MAX_HEADER_LENGTH) {
      throw new Error(`Stage ${stage.id} needs a concise header.`);
    }
    if (!stage.prompt || stage.prompt.length > 20_000) throw new Error(`Stage ${stage.id} needs a prompt.`);
    if (stage.description && stage.description.length > 10_000) throw new Error(`Stage ${stage.id} description is too long.`);
    if (stage.imagePrompt && stage.imagePrompt.length > 20_000) throw new Error(`Stage ${stage.id} imagePrompt is too long.`);
    if (stage.options.length < MIN_OPTIONS || stage.options.length > MAX_OPTIONS) {
      throw new Error(`Stage ${stage.id} must have ${MIN_OPTIONS}-${MAX_OPTIONS} options.`);
    }

    const labels = new Set<string>();
    const ids = new Set<string>();
    for (const option of stage.options) {
      if (!option.id || option.id.length > MAX_STAGE_ID_LENGTH || ids.has(option.id)) {
        throw new Error(`Option ids must be unique in stage ${stage.id}.`);
      }
      ids.add(option.id);
      if (!option.label || option.label.length > MAX_LABEL_LENGTH) {
        throw new Error(`Option ${option.id} needs a label of at most ${MAX_LABEL_LENGTH} characters.`);
      }
      const labelKey = option.label.toLowerCase();
      if (isReservedLabel(option.label)) throw new Error(`Option label is reserved: ${option.label}`);
      if (labels.has(labelKey)) throw new Error(`Option labels must be unique in stage ${stage.id}.`);
      labels.add(labelKey);
      if (option.description && option.description.length > 4_000) throw new Error(`Description for option ${option.id} is too long.`);
      if (option.preview && option.preview.length > 20_000) throw new Error(`Preview for option ${option.id} is too long.`);
      if (option.value && option.value.length > 2_000) throw new Error(`Value for option ${option.id} is too long.`);
      if (option.image) validateImage(option.image, option.id);
    }
  }
  for (const id of review.resetStageIds) {
    if (!stageIds.has(id)) throw new Error(`Cannot reset unknown stage id: ${id}`);
  }
}
