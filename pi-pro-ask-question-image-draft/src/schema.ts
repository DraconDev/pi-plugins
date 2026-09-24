import { Type, type Static } from "typebox";

export const MAX_STAGES = 6;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_HEADER_LENGTH = 32;
export const MAX_LABEL_LENGTH = 80;
export const MAX_STAGE_ID_LENGTH = 64;

export const RESERVED_LABELS = ["Type something.", "Other", "Request revision", "Approve", "Reject"] as const;

const ImageReferenceSchema = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "Local image path returned by an image-generation tool." })),
    url: Type.Optional(Type.String({ description: "Optional remote image URL. The file is downloaded for inline preview." })),
    dataUri: Type.Optional(Type.String({ description: "Optional image data URI (data:image/...;base64,...)." })),
    mimeType: Type.Optional(Type.String({ description: "Optional MIME type, for example image/png." })),
    alt: Type.Optional(Type.String({ description: "Accessible description of the image." })),
  },
  { description: "A local path, remote URL, or data URI for one generated image." },
);

const PreviewSchema = Type.String({
  description:
    "Markdown or plain-text fallback shown when the image cannot be displayed. Keep it concise; do not use ASCII art when an image reference is available.",
});

const OptionSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: MAX_STAGE_ID_LENGTH, description: "Stable option identifier." })),
  label: Type.String({ maxLength: MAX_LABEL_LENGTH, description: "Concise option label (1-5 words is recommended)." }),
  description: Type.Optional(Type.String({ description: "What this option means and its trade-offs." })),
  preview: Type.Optional(PreviewSchema),
  image: Type.Optional(ImageReferenceSchema),
});

const StageSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: MAX_STAGE_ID_LENGTH, description: "Stable stage identifier for revision/resume." })),
  header: Type.String({ maxLength: MAX_HEADER_LENGTH, description: "Short stage title shown in the wizard tab bar." }),
  prompt: Type.String({ description: "The complete question or review instruction for this stage." }),
  description: Type.Optional(Type.String({ description: "Optional context shown below the prompt." })),
  options: Type.Array(OptionSchema, { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS, description: "2-6 choices for this stage." }),
  allowOther: Type.Optional(Type.Boolean({ description: "Append a custom text answer row (default: true)." })),
  allowRevision: Type.Optional(Type.Boolean({ description: "Append a revision request row (default: true)." })),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option (default: false)." })),
});

const QuestionsSchema = Type.Array(
  Type.Object({
    question: Type.String({ description: "The complete question to ask." }),
    header: Type.Optional(Type.String({ maxLength: MAX_HEADER_LENGTH, description: "Short tab label." })),
    options: Type.Array(OptionSchema, { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS }),
    multiSelect: Type.Optional(Type.Boolean()),
    allowOther: Type.Optional(Type.Boolean()),
  }),
  { minItems: 1, maxItems: 4, description: "Legacy-compatible simple question stages." },
);

const StagesSchema = Type.Array(StageSchema, { minItems: 1, maxItems: MAX_STAGES, description: "Ordered review stages." });

export const ReviewParamsSchema = Type.Object({
  stages: Type.Optional(StagesSchema),
  questions: Type.Optional(QuestionsSchema),
  title: Type.Optional(Type.String({ description: "Optional title for the review wizard." })),
  reviewId: Type.Optional(Type.String({ description: "Stable id used to resume a review after a revision." })),
  round: Type.Optional(Type.Integer({ minimum: 1, description: "Revision round, starting at 1." })),
  notes: Type.Optional(Type.String({ description: "Optional notes shown on the final review tab." })),
  provider: Type.Optional(Type.String({ description: "Image provider metadata to carry into the next generation request." })),
  model: Type.Optional(Type.String({ description: "Image model metadata to carry into the next generation request." })),
});

export type ImageReference = Static<typeof ImageReferenceSchema>;
export type ReviewOption = Static<typeof OptionSchema>;
export type ReviewStage = Static<typeof StageSchema>;
export type ReviewParams = Static<typeof ReviewParamsSchema>;

export interface NormalizedOption {
  id: string;
  label: string;
  description?: string;
  preview?: string;
  image?: ImageReference;
}

export interface NormalizedStage {
  id: string;
  header: string;
  prompt: string;
  description?: string;
  options: NormalizedOption[];
  allowOther: boolean;
  allowRevision: boolean;
  multiSelect: boolean;
}

export interface NormalizedReview {
  title?: string;
  stages: NormalizedStage[];
  reviewId: string;
  round: number;
  notes?: string;
  provider?: string;
  model?: string;
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function uniqueId(prefix: string, index: number, used: Set<string>): string {
  const base = `${prefix}-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function normalizeImage(image: ImageReference | undefined): ImageReference | undefined {
  if (!image) return undefined;
  const out: ImageReference = {};
  if (image.path !== undefined) out.path = normalizeText(image.path).trim();
  if (image.url !== undefined) out.url = normalizeText(image.url).trim();
  if (image.dataUri !== undefined) out.dataUri = image.dataUri.trim();
  if (image.mimeType !== undefined) out.mimeType = image.mimeType.trim().toLowerCase();
  if (image.alt !== undefined) out.alt = normalizeText(image.alt).trim();
  return out;
}

export function normalizeReview(params: ReviewParams, now = Date.now()): NormalizedReview {
  const rawStages = params.stages?.length
    ? params.stages
    : params.questions?.map((question, index) => ({
        id: `question-${index + 1}`,
        header: question.header ?? `Q${index + 1}`,
        prompt: question.question,
        options: question.options,
        allowOther: question.allowOther,
        allowRevision: false,
        multiSelect: question.multiSelect,
      }));

  if (!rawStages?.length) {
    throw new Error("Provide at least one stage (or a legacy questions array).");
  }

  const usedStageIds = new Set<string>();
  const stages = rawStages.map((stage, stageIndex) => {
    const id = stage.id?.trim() || uniqueId("stage", stageIndex, usedStageIds);
    if (usedStageIds.has(id) && stage.id?.trim()) {
      throw new Error(`Duplicate stage id: ${id}`);
    }
    usedStageIds.add(id);
    const usedOptionIds = new Set<string>();
    const options = stage.options.map((option, optionIndex) => {
      const optionId = option.id?.trim() || uniqueId(`${id}-option`, optionIndex, usedOptionIds);
      if (usedOptionIds.has(optionId) && option.id?.trim()) {
        throw new Error(`Duplicate option id in stage ${id}: ${optionId}`);
      }
      usedOptionIds.add(optionId);
      return {
        id: optionId,
        label: normalizeText(option.label).trim(),
        description: option.description === undefined ? undefined : normalizeText(option.description).trim(),
        preview: option.preview === undefined ? undefined : normalizeText(option.preview),
        image: normalizeImage(option.image),
      } satisfies NormalizedOption;
    });
    return {
      id,
      header: normalizeText(stage.header).trim(),
      prompt: normalizeText(stage.prompt).trim(),
      description: stage.description === undefined ? undefined : normalizeText(stage.description).trim(),
      options,
      allowOther: stage.allowOther !== false,
      // Legacy questions do not get a revision row unless explicitly requested.
      allowRevision: params.stages ? stage.allowRevision !== false : stage.allowRevision === true,
      multiSelect: stage.multiSelect === true,
    } satisfies NormalizedStage;
  });

  return {
    title: params.title === undefined ? undefined : normalizeText(params.title).trim(),
    stages,
    reviewId: params.reviewId?.trim() || `review-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    round: Math.max(1, params.round ?? 1),
    notes: params.notes === undefined ? undefined : normalizeText(params.notes),
    provider: params.provider?.trim() || undefined,
    model: params.model?.trim() || undefined,
  };
}

export function validateReview(review: NormalizedReview): void {
  if (review.stages.length < 1 || review.stages.length > MAX_STAGES) {
    throw new Error(`A review must contain 1-${MAX_STAGES} stages.`);
  }
  const stageIds = new Set<string>();
  for (const stage of review.stages) {
    if (!stage.id || stageIds.has(stage.id)) throw new Error(`Stage ids must be unique and non-empty: ${stage.id}`);
    stageIds.add(stage.id);
    if (!stage.header || !stage.prompt) throw new Error(`Stage ${stage.id} needs a header and prompt.`);
    if (stage.options.length < MIN_OPTIONS || stage.options.length > MAX_OPTIONS) {
      throw new Error(`Stage ${stage.id} must have ${MIN_OPTIONS}-${MAX_OPTIONS} options.`);
    }
    const labels = new Set<string>();
    const ids = new Set<string>();
    for (const option of stage.options) {
      if (!option.id || ids.has(option.id)) throw new Error(`Option ids must be unique in stage ${stage.id}.`);
      ids.add(option.id);
      if (!option.label || labels.has(option.label)) throw new Error(`Option labels must be unique in stage ${stage.id}.`);
      if ((RESERVED_LABELS as readonly string[]).includes(option.label)) {
        throw new Error(`Option label is reserved: ${option.label}`);
      }
      labels.add(option.label);
      if (option.image && !option.image.path && !option.image.url && !option.image.dataUri) {
        throw new Error(`Image on option ${option.id} needs path, url, or dataUri.`);
      }
    }
  }
}
