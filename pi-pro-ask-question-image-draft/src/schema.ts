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
export const MAX_GENERATION_PROMPT_LENGTH = 20_000;

/** Labels owned by the wizard. Authors must use a different label for real options. */
export const REVIEW_CONTROL_LABELS = {
  other: "Type something.",
  done: "Done selecting",
  skip: "Skip stage",
  revision: "Request revision",
  approve: "Approve review",
  reject: "Reject review",
} as const;

export const RESERVED_LABELS = [
  "Other",
  "Next",
  "Edit answers",
  "Review & approve",
  ...Object.values(REVIEW_CONTROL_LABELS),
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

/** Explicit, opt-in image generation request for one visual option. */
export const ImageGenerationSchema = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      maxLength: MAX_GENERATION_PROMPT_LENGTH,
      description: "Prompt sent to the configured image provider. Generation is never implicit.",
    }),
    provider: Type.Optional(Type.String({ maxLength: 100, description: "Image provider id, for example agnes or agnes-cn." })),
    model: Type.Optional(Type.String({ maxLength: 200, description: "Provider-specific image model id." })),
    negativePrompt: Type.Optional(Type.String({ maxLength: MAX_GENERATION_PROMPT_LENGTH })),
    size: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { description: "Generate this option's image before opening the review. The tool returns a local path." },
);

/**
 * A deterministic mockup: the option's own content, drawn by the package rather
 * than sampled from a provider. It exists because a generated image cannot be
 * read at terminal size - 34.5% of generated previews were judged severely
 * unreadable on a 31 x 16 cell grid - while a mockup drawn on that grid is.
 */
export const MockupRowSchema = Type.Object({
  status: Type.Optional(Type.Union([
    Type.Literal("danger"), Type.Literal("warn"), Type.Literal("ok"), Type.Literal("accent"), Type.Literal("muted"),
  ], { description: "Colour of the status chip drawn beside the row." })),
  code: Type.Optional(Type.String({ maxLength: 6, description: "Two or three characters of dense content, like a badge." })),
  label: Type.String({ maxLength: 120, description: "The row's visible label." }),
  value: Type.Optional(Type.Number({ description: "0..1, drawn as a bar." })),
  detail: Type.Optional(Type.String({ maxLength: 200 })),
}, { description: "One row of mockup content." });

export const MockupSchema = Type.Object({
  layout: Type.Optional(Type.Union([
    Type.Literal("list"), Type.Literal("airy"), Type.Literal("split"), Type.Literal("dense"), Type.Literal("rail"),
    Type.Literal("board"), Type.Literal("chart"), Type.Literal("overlay"), Type.Literal("steps"), Type.Literal("tiles"),
  ], { description: "The arrangement to draw. This is the decision a reviewer is comparing." })),
  title: Type.Optional(Type.String({ maxLength: 80, description: "Title bar text. Omit to keep a comparison blind." })),
  emphasis: Type.Optional(Type.Union([
    Type.Literal("dialog"), Type.Literal("banner"), Type.Literal("toast"), Type.Literal("sheet"), Type.Literal("highlight"),
  ])),
  headers: Type.Optional(Type.Array(Type.String({ maxLength: 20 }), { maxItems: 4 })),
  rows: Type.Array(MockupRowSchema, { minItems: 1, maxItems: 32, description: "Content to draw, top to bottom." }),
  widthCells: Type.Optional(Type.Number({ description: "Preview width in character cells; defaults to the TUI's panel width." })),
  heightCells: Type.Optional(Type.Number({ description: "Preview height in character cells; defaults to the TUI's image height." })),
}, { description: "Draw this option's image deterministically instead of generating it." });

export const ReviewOptionSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: MAX_STAGE_ID_LENGTH, description: "Stable option identifier." })),
  label: Type.String({ maxLength: MAX_LABEL_LENGTH, description: "Concise option label (1-5 words is recommended)." }),
  description: Type.Optional(Type.String({ maxLength: 4_000, description: "What this option means and its trade-offs." })),
  recommended: Type.Optional(Type.Boolean({ description: "Mark this as the option the model recommends. Marked rows say so, and auto-resolve lands on them." })),
  /**
   * Plain-text lines saying what this option changes, in order.
   *
   * The content area of a review is one big block, and the way to fill it
   * without a picture or a drawing is to let each option carry its own
   * description of the change it proposes. A reviewer reads these and decides
   * on the difference, not on the surface.
   */
  changes: Type.Optional(
    Type.Array(Type.String({ maxLength: 280 }), { maxItems: 16, description: "What this option changes, one item per line." }),
  ),
  value: Type.Optional(Type.String({ maxLength: 2_000, description: "Optional machine-readable value to return when this option is selected." })),
  preview: Type.Optional(PreviewSchema),
  image: Type.Optional(ImageInputSchema),
  generate: Type.Optional(ImageGenerationSchema),
  mockup: Type.Optional(MockupSchema),
});

export const ReviewStageSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: MAX_STAGE_ID_LENGTH, description: "Stable stage identifier for revision/resume." })),
  images: Type.Optional(
    Type.Array(ImageInputSchema, {
      maxItems: MAX_OPTIONS,
      description: "One image per option, in the same order as options - the same images options[].image carries, for hosts that present them per question.",
    }),
  ),
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
  imagePrompt: Type.Optional(Type.String({ maxLength: MAX_GENERATION_PROMPT_LENGTH, description: "Prompt or notes for generating this stage's images on a later round." })),
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
    imagePrompt: Type.Optional(Type.String({ maxLength: MAX_GENERATION_PROMPT_LENGTH })),
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
  rounds: Type.Optional(Type.Integer({ minimum: 1, description: "How many rounds this review is expected to take, so the panel can say 'round 1 of 3'. Omit when the model does not know - the header then says only which round this is." })),
  /**
   * How much fits in the fixed block.
   *
   * `comfortable` prints a reason under every choice; `compact` prints the
   * choices alone and moves the highlighted option's reason into the content
   * area, so a long list fits and the conversation stays readable. The default
   * is unchanged from what the panel has always done.
   */
  density: Type.Optional(Type.Union([Type.Literal("comfortable"), Type.Literal("compact")], {
    description: "Row density for the option list. \"comfortable\" (default) puts a reason under each choice; \"compact\" lists the choices and shows the highlighted one's reason in the content area.",
  })),
  images: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("on")], {
    description: "Whether an option's image is drawn. Off by default: a generated image is decoration, and the structure is the part a reviewer decides on. Set \"on\" to show it as well.",
  })),
  autoResolve: Type.Optional(Type.Boolean({
    description: "Pre-select the recommended option on every stage, so Enter resolves it. Off by default; the user toggles it with Ctrl+A and always still presses Enter themselves.",
  })),
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
export type ImageGeneration = Static<typeof ImageGenerationSchema>;
export type ReviewOption = Static<typeof ReviewOptionSchema>;
export type MockupRow = Static<typeof MockupRowSchema>;
export type MockupSpec = Static<typeof MockupSchema>;
export type ReviewStage = Static<typeof ReviewStageSchema>;
export type ReviewParams = Static<typeof ReviewParamsSchema>;
export type GenerationSpec = Static<typeof GenerationSpecSchema>;

export interface NormalizedImageGeneration {
  prompt: string;
  provider?: string;
  model?: string;
  negativePrompt?: string;
  size?: string;
}

export interface NormalizedOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  value?: string;
  /** Plain-text changes this option proposes, in order. */
  changes?: string[];
  preview?: string;
  image?: ImageReference;
  generate?: NormalizedImageGeneration;
  mockup?: MockupSpec;
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
  /** How many rounds to expect, when the model said so. */
  rounds?: number;
  /**
   * Off unless the review asks for pictures.
   *
   * The photograph is the part of a preview that carries no information, and it
   * is also the part that needs a terminal that speaks a graphics protocol. The
   * drawn structure is the default; `images: "on"` opts back in.
   */
  images: "off" | "on";
  /** Row density for the option list; comfortable unless the review says compact. */
  density: "comfortable" | "compact";
  /** Pre-select the recommended option per stage. Off unless asked for. */
  autoResolve?: boolean;
  resetStageIds: string[];
  notes?: string;
  provider?: string;
  model?: string;
  imagePrompt?: string;
  generation?: NormalizedGeneration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function optionalText(value: unknown, field = "value"): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
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
    if (!value) throw new Error("image must be a non-empty string or image reference object.");
    if (isDataUri(value)) return { dataUri: value };
    if (/^https?:\/\//i.test(value)) return { url: value };
    // Keep file URLs in the path field so the loader can resolve them locally.
    if (/^file:\/\//i.test(value)) return { path: value };
    return { path: value };
  }

  if (!isRecord(image)) throw new Error("image must be a string or an image reference object.");
  for (const key of ["path", "url", "dataUri", "mimeType", "alt"] as const) {
    if (image[key] !== undefined && typeof image[key] !== "string") {
      throw new Error(`image.${key} must be a string.`);
    }
  }
  const out: ImageReference = {};
  const path = optionalText(image.path, "image.path");
  const url = optionalText(image.url, "image.url");
  const dataUri = optionalText(image.dataUri, "image.dataUri");
  const mimeType = optionalText(image.mimeType, "image.mimeType")?.toLowerCase().split(";", 1)[0];
  const alt = optionalText(image.alt, "image.alt");
  if (path) out.path = path;
  if (url) out.url = url;
  if (dataUri) out.dataUri = dataUri;
  if (mimeType) out.mimeType = mimeType;
  if (alt) out.alt = alt;
  if (!out.path && !out.url && !out.dataUri) throw new Error("image needs path, url, or dataUri.");
  if (Object.keys(out).length === 0) throw new Error("image needs path, url, or dataUri.");
  return out;
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
  /**
   * One image per option, in the same order as `options`.
   *
   * Hosts present the artwork here rather than on each option, and a stage-level
   * image that is dropped without a word is the worst possible failure for a
   * tool whose whole point can be a picture: the review renders perfectly and
   * simply has nothing to show.
   */
  images?: readonly unknown[];
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
    // Hosts present the artwork on the question, one entry per option.
    images: Array.isArray((question as unknown as { image?: unknown }).image)
      ? (question as unknown as { image: unknown[] }).image
      : undefined,
  };
}

function assertRawOption(value: unknown, stageIndex: number, optionIndex: number): asserts value is ReviewOption {
  if (!isRecord(value) || typeof value.label !== "string") {
    throw new Error(`Stage ${stageIndex + 1} option ${optionIndex + 1} needs a label.`);
  }
  for (const key of ["id", "description", "value", "preview"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`Stage ${stageIndex + 1} option ${optionIndex + 1}.${key} must be a string.`);
    }
  }
  if (value.image !== undefined) normalizeImage(value.image as ImageInput);
  if (value.generate !== undefined) normalizeImageGeneration(value.generate, `Stage ${stageIndex + 1} option ${optionIndex + 1}`);
}

/**
 * The unions the schema *declares* and the normaliser used to *cast* to.
 *
 * There is no runtime TypeBox validation in this project, so a `Type.Literal`
 * union in `MockupSchema` is documentation: nothing checked it, and the renderer
 * then switched on whatever string arrived. Naming the members here is what
 * makes the union real, and it is one list rather than three inline arrays.
 */
const MOCKUP_LAYOUTS = ["list", "airy", "split", "dense", "rail", "board", "chart", "overlay", "steps", "tiles"] as const;
const MOCKUP_EMPHASIS = ["dialog", "banner", "toast", "sheet", "highlight"] as const;
const MOCKUP_STATUS = ["danger", "warn", "ok", "accent", "muted"] as const;

/** Bounds for the geometry the renderer turns straight into pixel dimensions. */
const MOCKUP_CELL_LIMITS = { min: 1, max: 400 } as const;

/**
 * A finite number inside a range, or a thrown error naming the field.
 *
 * `NaN` is the reason this exists: every comparison with it is false, so a range
 * check written as `value < min || value > max` passes it, and `NaN` then
 * reaches the renderer as a bar width or a canvas dimension.
 */
const boundedNumber = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}.`);
  }
  return Math.floor(value);
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
};

/** A string from input, bounded, or undefined - never an arbitrary-length one. */
const boundedText = (value: unknown, field: string, maxLength: number): string | undefined => {
  if (value === undefined) return undefined;
  const text = optionalText(value, field);
  if (text === undefined) return undefined;
  if (text.length > maxLength) throw new Error(`${field} is longer than ${maxLength} characters.`);
  return text;
};

function normalizeMockup(value: unknown, field: string): MockupSpec {
  if (!isRecord(value)) throw new Error(`${field}.mockup must be an object.`);
  const rows = value.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 32) {
    throw new Error(`${field}.mockup.rows must be an array of 1 through 32 rows.`);
  }
  const normalizedRows = rows.map((row, index) => {
    if (!isRecord(row)) throw new Error(`${field}.mockup.rows[${index}] must be an object.`);
    const label = optionalText(row.label, `${field}.mockup.rows[${index}].label`);
    if (!label) throw new Error(`${field}.mockup.rows[${index}].label must be a non-empty string.`);
    if (label.length > 120) throw new Error(`${field}.mockup.rows[${index}].label is too long.`);
    if (row.value !== undefined) {
      // Every comparison with NaN is false, so the old `row.value < 0 || row.value > 1`
      // check waved NaN straight through to the bar renderer.
      boundedNumber(row.value, `${field}.mockup.rows[${index}].value`, 0, 1);
    }
    return {
      status: oneOf(row.status, MOCKUP_STATUS, `${field}.mockup.rows[${index}].status`),
      code: boundedText(row.code, `${field}.mockup.rows[${index}].code`, 6),
      label,
      value: row.value as number | undefined,
      detail: boundedText(row.detail, `${field}.mockup.rows[${index}].detail`, 200),
    };
  });
  let headers: string[] | undefined;
  if (value.headers !== undefined) {
    if (!Array.isArray(value.headers) || value.headers.length > 4) {
      throw new Error(`${field}.mockup.headers must be an array of at most 4 headers.`);
    }
    headers = value.headers.map((header, index) => {
      const text = String(header);
      if (text.length > 20) throw new Error(`${field}.mockup.headers[${index}] is longer than 20 characters.`);
      return text;
    });
  }
  return {
    layout: oneOf(value.layout, MOCKUP_LAYOUTS, `${field}.mockup.layout`),
    title: boundedText(value.title, `${field}.mockup.title`, 120),
    emphasis: oneOf(value.emphasis, MOCKUP_EMPHASIS, `${field}.mockup.emphasis`),
    headers,
    rows: normalizedRows,
    // These go straight to `new Canvas(widthCells * 8, heightCells * 16)`, so a
    // negative one throws an uncaught RangeError and a huge one allocates.
    widthCells: value.widthCells === undefined ? undefined : boundedNumber(value.widthCells, `${field}.mockup.widthCells`, MOCKUP_CELL_LIMITS.min, MOCKUP_CELL_LIMITS.max),
    heightCells: value.heightCells === undefined ? undefined : boundedNumber(value.heightCells, `${field}.mockup.heightCells`, MOCKUP_CELL_LIMITS.min, MOCKUP_CELL_LIMITS.max),
  };
}

function normalizeImageGeneration(value: unknown, field: string): NormalizedImageGeneration {
  if (!isRecord(value)) throw new Error(`${field}.generate must be an object.`);
  const prompt = optionalText(value.prompt, `${field}.generate.prompt`);
  if (!prompt) throw new Error(`${field}.generate.prompt must be a non-empty string.`);
  for (const key of ["provider", "model", "negativePrompt", "size"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${field}.generate.${key} must be a string.`);
    }
  }
  return {
    prompt,
    provider: optionalText(value.provider, `${field}.generate.provider`),
    model: optionalText(value.model, `${field}.generate.model`),
    negativePrompt: optionalText(value.negativePrompt, `${field}.generate.negativePrompt`),
    size: optionalText(value.size, `${field}.generate.size`),
  };
}

function assertRawStage(value: unknown, stageIndex: number): asserts value is RawStage {
  if (!isRecord(value) || typeof value.header !== "string" || typeof value.prompt !== "string") {
    throw new Error(`Stage ${stageIndex + 1} needs header and prompt strings.`);
  }
  if (!Array.isArray(value.options)) throw new Error(`Stage ${stageIndex + 1} options must be an array.`);
  if (value.kind !== undefined && value.kind !== "choice" && value.kind !== "draft") {
    throw new Error(`Stage ${stageIndex + 1}.kind must be choice or draft.`);
  }
  for (const key of ["id", "description", "imagePrompt"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`Stage ${stageIndex + 1}.${key} must be a string.`);
    }
  }
  for (const key of ["allowOther", "allowRevision", "multiSelect", "required"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`Stage ${stageIndex + 1}.${key} must be a boolean.`);
    }
  }
  value.options.forEach((option, optionIndex) => assertRawOption(option, stageIndex, optionIndex));
}

function assertRawQuestion(value: unknown, index: number): Static<typeof QuestionsSchema>[number] {
  if (!isRecord(value) || typeof value.question !== "string") {
    throw new Error(`Question ${index + 1} needs a question string.`);
  }
  assertRawStage({
    ...value,
    header: typeof value.header === "string" ? value.header : `Q${index + 1}`,
    prompt: value.question,
  }, index);
  return value as Static<typeof QuestionsSchema>[number];
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
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Visual review parameters must be an object.");
  }

  const suppliedStages = Array.isArray(params.stages)
    ? (params.stages as unknown[]).map((stage, index) => {
        assertRawStage(stage, index);
        return stage;
      })
    : undefined;
  const legacyQuestions = Array.isArray(params.questions)
    ? (params.questions as unknown[]).map((question, index) => assertRawQuestion(question, index))
    : [];
  if (suppliedStages?.length && legacyQuestions.length) {
    throw new Error("Provide either stages or legacy questions, not both.");
  }
  const rawStages: readonly RawStage[] = suppliedStages?.length
    ? suppliedStages
    : legacyQuestions.map(rawStageFromQuestion);

  if (!rawStages.length) {
    throw new Error("Provide at least one stage (or a legacy questions array).");
  }
  if (rawStages.some((stage) => !Array.isArray(stage.options) || stage.options.length < MIN_OPTIONS)) {
    throw new Error(`Every stage must contain at least ${MIN_OPTIONS} options.`);
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
    const stageImages = stage.images ?? [];
    if (stageImages.length > stage.options.length) {
      throw new Error(
        `Stage ${id} carries ${stageImages.length} images for ${stage.options.length} options; put one image per option, in order.`,
      );
    }
    stageImages.forEach((image, imageIndex) => {
      if (!image || typeof image !== "object" || Array.isArray(image)) {
        throw new Error(`Stage ${id} image ${imageIndex + 1} must be an object with a path, url or dataUri.`);
      }
      // An object that carries none of them is a shape we cannot draw, and a
      // shape we cannot draw must say so: normalizeImage names the problem, and
      // a stage-level entry gets the stage and position with it.
      try {
        normalizeImage(image as { path?: string; url?: string; dataUri?: string });
      } catch {
        throw new Error(`Stage ${id} image ${imageIndex + 1} has no path, url or dataUri, so there is nothing to draw.`);
      }
    });
    // Hosts present the artwork per question; an option's own image still wins.
    const stagedReference = (optionIndex: number) => {
      const staged = stageImages[optionIndex];
      if (!staged || typeof staged !== "object" || Array.isArray(staged)) return undefined;
      return staged as { path?: string; url?: string; dataUri?: string; mimeType?: string; alt?: string };
    };
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
        // `recommended` is checked rather than coerced: `"yes"` used to be
        // silently dropped, so a model that got the type wrong got no marker and
        // no complaint.
        ...(option.recommended !== undefined && option.recommended !== true
          ? (() => { throw new Error(`Option ${optionId} recommended must be true when present.`); })()
          : {}),
        // The option's own change list: plain text, in order, blanks dropped.
        // Bounded, because every entry is rendered into the panel and the
        // declared limits were never enforced: a model could send ten thousand
        // lines of arbitrary length and the panel would try to draw them.
        changes: Array.isArray(option.changes)
          ? option.changes.map((line, lineIndex) => {
            const text = String(line);
            if (text.length > 280) {
              throw new Error(`Option ${optionId} changes[${lineIndex}] is longer than 280 characters.`);
            }
            return text;
          }).filter((line) => line.trim().length > 0).slice(0, 16)
          : undefined,
        value: optionalText(option.value),
        preview: option.preview === undefined ? undefined : normalizeText(option.preview),
        // A stage-level image fills in only where the option carries none of its own.
        image: normalizeImage(option.image ?? stagedReference(optionIndex)),
        generate: option.generate === undefined
          ? undefined
          : normalizeImageGeneration(option.generate, `Stage ${id} option ${optionId}`),
        mockup: option.mockup === undefined
          ? undefined
          : normalizeMockup(option.mockup, `Stage ${id} option ${optionId}`),
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

  if (params.title !== undefined && typeof params.title !== "string") throw new Error("title must be a string.");
  if (params.reviewId !== undefined && typeof params.reviewId !== "string") throw new Error("reviewId must be a string.");
  if (params.round !== undefined && (typeof params.round !== "number" || !Number.isInteger(params.round))) {
    throw new Error("round must be a positive integer.");
  }
  if (params.rounds !== undefined && (typeof params.rounds !== "number" || !Number.isInteger(params.rounds) || params.rounds < 1)) {
    throw new Error("rounds must be a positive integer.");
  }
  // A total below the round already reached is not a total, it is a mistake, and
  // "round 3 of 2" in the header would be worse than no total at all.
  if (params.rounds !== undefined && (params.round ?? 1) > params.rounds) {
    throw new Error(`rounds (${params.rounds}) cannot be less than round (${params.round ?? 1}).`);
  }
  if (params.notes !== undefined && typeof params.notes !== "string") throw new Error("notes must be a string.");
  if (params.provider !== undefined && typeof params.provider !== "string") throw new Error("provider must be a string.");
  if (params.model !== undefined && typeof params.model !== "string") throw new Error("model must be a string.");
  if (params.imagePrompt !== undefined && typeof params.imagePrompt !== "string") throw new Error("imagePrompt must be a string.");
  if (params.generation !== undefined && !isRecord(params.generation)) throw new Error("generation must be an object.");
  if (params.resetStageIds !== undefined && (!Array.isArray(params.resetStageIds) || params.resetStageIds.some((id) => typeof id !== "string"))) {
    throw new Error("resetStageIds must be an array of strings.");
  }

  const round = params.round ?? 1;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) {
    throw new Error("round must be a positive integer.");
  }
  if (params.autoResolve !== undefined && typeof params.autoResolve !== "boolean") {
    throw new Error("autoResolve must be a boolean.");
  }
  if (params.images !== undefined && params.images !== "off" && params.images !== "on") {
    throw new Error("images must be \"off\" or \"on\".");
  }
  if (params.density !== undefined && params.density !== "comfortable" && params.density !== "compact") {
    throw new Error("density must be \"comfortable\" or \"compact\".");
  }

  return {
    title: optionalText(params.title),
    stages,
    reviewId: optionalText(params.reviewId) || `review-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
    round,
    ...(params.rounds === undefined ? {} : { rounds: params.rounds }),
    images: params.images === "on" ? "on" : "off",
    density: params.density === "compact" ? "compact" : "comfortable",
    autoResolve: params.autoResolve === true ? true : undefined,
    resetStageIds: [
      ...new Set(
        (Array.isArray(params.resetStageIds) ? params.resetStageIds : []).map((id) => normalizeText(id).trim()).filter(Boolean),
      ),
    ],
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
    const encoded = image.dataUri.slice(image.dataUri.indexOf(",") + 1).replace(/\s+/g, "");
    if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error(`Image data URI on option ${optionId} contains invalid base64 data.`);
    }
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
  if (review.imagePrompt && review.imagePrompt.length > 20_000) throw new Error("imagePrompt is too long.");
  if (review.generation) {
    if (review.generation.prompt && review.generation.prompt.length > MAX_GENERATION_PROMPT_LENGTH) throw new Error("generation.prompt is too long.");
    if (review.generation.negativePrompt && review.generation.negativePrompt.length > MAX_GENERATION_PROMPT_LENGTH) {
      throw new Error("generation.negativePrompt is too long.");
    }
    if (review.generation.provider && review.generation.provider.length > 100) throw new Error("generation.provider is too long.");
    if (review.generation.model && review.generation.model.length > 200) throw new Error("generation.model is too long.");
    if (review.generation.size && review.generation.size.length > 100) throw new Error("generation.size is too long.");
  }
  if (review.resetStageIds.some((id) => !id)) throw new Error("resetStageIds cannot contain empty ids.");

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
      if (option.mockup) {
        if (option.image) throw new Error(`Option ${option.id} cannot provide both image and mockup; choose one source.`);
        if (option.generate) throw new Error(`Option ${option.id} cannot provide both generate and mockup; choose one source.`);
        if (option.mockup.title !== undefined && option.mockup.title.length > 80) {
          throw new Error(`Mockup title for option ${option.id} is too long.`);
        }
        for (const [index, row] of (option.mockup.rows ?? []).entries()) {
          if (row.label.length > 120) throw new Error(`Mockup row ${index} label for option ${option.id} is too long.`);
          if (row.value !== undefined && (row.value < 0 || row.value > 1)) {
            throw new Error(`Mockup row ${index} value for option ${option.id} must be between 0 and 1.`);
          }
        }
      }
      if (option.generate) {
        if (option.image) throw new Error(`Option ${option.id} cannot provide both image and generate; choose one source.`);
        if (option.generate.prompt.length > MAX_GENERATION_PROMPT_LENGTH) {
          throw new Error(`Generation prompt for option ${option.id} is too long.`);
        }
        if (option.generate.provider && option.generate.provider.length > 100) {
          throw new Error(`Generation provider for option ${option.id} is too long.`);
        }
        if (option.generate.model && option.generate.model.length > 200) {
          throw new Error(`Generation model for option ${option.id} is too long.`);
        }
        if (option.generate.negativePrompt && option.generate.negativePrompt.length > MAX_GENERATION_PROMPT_LENGTH) {
          throw new Error(`Negative prompt for option ${option.id} is too long.`);
        }
        if (option.generate.size && option.generate.size.length > 100) {
          throw new Error(`Generation size for option ${option.id} is too long.`);
        }
      }
    }
  }
  const resetIds = new Set<string>();
  for (const id of review.resetStageIds) {
    if (!stageIds.has(id)) throw new Error(`Cannot reset unknown stage id: ${id}`);
    if (resetIds.has(id)) throw new Error(`Duplicate reset stage id: ${id}`);
    resetIds.add(id);
  }
}
