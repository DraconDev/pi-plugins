import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  HStack,
  Image,
  Key,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  Markdown,
  matchesKey,
  SelectList,
  type SelectItem,
  type SelectListTheme,
  Spacer,
  Text,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { canRenderImages, imageFileLink, loadImage, type LoadedImage } from "./image-loader.ts";
import type { NormalizedOption, NormalizedReview, NormalizedStage } from "./schema.ts";
import {
  makeCustomAnswer,
  makeOptionAnswer,
  type ReviewAnswer,
  type ReviewResult,
  type ReviewRevision,
} from "./state.ts";

interface LoadedOption {
  image?: LoadedImage;
  error?: string;
}

type Row =
  | { kind: "option"; option: NormalizedOption }
  | { kind: "other" }
  | { kind: "revision" }
  | { kind: "submit" };

export interface VisualReviewWizardOptions {
  review: NormalizedReview;
  cwd: string;
  initialAnswers?: ReviewAnswer[];
  signal?: AbortSignal;
}

const OTHER_LABEL = "Type something.";
const REVISION_LABEL = "Request revision";
const SUBMIT_LABEL = "Review & approve";

function markdownTheme(theme: Theme): MarkdownTheme {
  const fg = (color: Parameters<Theme["fg"]>[0]) => (text: string) => theme.fg(color, text);
  return {
    heading: (text) => theme.bold(fg("mdHeading")(text)),
    link: fg("mdLink"),
    linkUrl: fg("mdLinkUrl"),
    code: fg("mdCode"),
    codeBlock: fg("mdCodeBlock"),
    codeBlockBorder: fg("mdCodeBlockBorder"),
    quote: fg("mdQuote"),
    quoteBorder: fg("mdQuoteBorder"),
    hr: fg("mdHr"),
    listBullet: fg("mdListBullet"),
    bold: (text) => theme.bold(text),
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => text,
    codeBlockIndent: "  ",
  };
}

function selectTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  };
}

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("accent", text),
    selectList: selectTheme(theme),
  };
}

function rowsForStage(stage: NormalizedStage): Row[] {
  const rows: Row[] = stage.options.map((option) => ({ kind: "option", option }));
  if (stage.allowOther) rows.push({ kind: "other" });
  if (stage.allowRevision) rows.push({ kind: "revision" });
  return rows;
}

function rowLabel(row: Row): string {
  switch (row.kind) {
    case "option":
      return row.option.label;
    case "other":
      return OTHER_LABEL;
    case "revision":
      return REVISION_LABEL;
    case "submit":
      return SUBMIT_LABEL;
  }
}

function rowDescription(row: Row): string | undefined {
  return row.kind === "option" ? row.option.description : row.kind === "revision" ? "Describe changes, then return to the model for regeneration" : undefined;
}

function answerForStage(answers: Map<string, ReviewAnswer>, stage: NormalizedStage): ReviewAnswer | undefined {
  return answers.get(stage.id);
}

function selectedIds(answer: ReviewAnswer | undefined): Set<string> {
  return new Set(answer?.optionIds ?? []);
}

function sameAnswer(a: ReviewAnswer | undefined, b: ReviewAnswer): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "custom") return a.customText === b.customText;
  return JSON.stringify(a.optionIds) === JSON.stringify(b.optionIds);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadOptionImages(review: NormalizedReview, cwd: string, signal?: AbortSignal): Promise<Map<string, LoadedOption>> {
  const loaded = new Map<string, LoadedOption>();
  await Promise.all(
    review.stages.flatMap((stage) =>
      stage.options.map(async (option) => {
        if (!option.image) return;
        const key = `${stage.id}:${option.id}`;
        try {
          loaded.set(key, { image: await loadImage(option.image, cwd, signal) });
        } catch (error) {
          loaded.set(key, { error: errorMessage(error) });
        }
      }),
    ),
  );
  return loaded;
}

function imageLines(image: LoadedImage, theme: Theme, width: number, maxHeight = 18): string[] {
  const component = new Image(image.base64, image.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, {
    maxWidthCells: Math.max(1, width - 2),
    maxHeightCells: maxHeight,
    filename: image.filename,
  }, image.dimensions);
  return component.render(Math.max(1, width));
}

/** Small text-only preview used when inline images are unavailable or loading failed. */
function fallbackPreview(option: NormalizedOption, loaded: LoadedOption | undefined, theme: Theme): string[] {
  const lines: string[] = [];
  const source = option.image?.path ?? option.image?.url;
  if (source) {
    lines.push(theme.fg("muted", loaded?.error ? `Image unavailable: ${loaded.error}` : `Image: ${imageFileLink(source)}`));
  }
  if (option.preview) lines.push(...wrapTextWithAnsi(option.preview, 72));
  if (!source && !option.preview) lines.push(theme.fg("dim", "No inline preview supplied."));
  return lines;
}

export class VisualReviewWizard implements Component {
  private readonly review: NormalizedReview;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly requestRender: () => void;
  private readonly done: (result: ReviewResult) => void;
  private readonly cwd: string;
  private readonly signal?: AbortSignal;
  private readonly answers: Map<string, ReviewAnswer>;
  private readonly loadedImages = new Map<string, LoadedOption>();
  private readonly editor: Editor;
  private readonly editorTheme: EditorTheme;
  private readonly imageMode: boolean;
  private stageIndex = 0;
  private selectedIndex = 0;
  private inputMode: "none" | "other" | "revision" = "none";
  private inputStageIndex = 0;
  private cachedWidth = -1;
  private cachedLines: string[] | undefined;
  private disposed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    review: NormalizedReview,
    cwd: string,
    done: (result: ReviewResult) => void,
    initialAnswers: ReviewAnswer[] = [],
    signal?: AbortSignal,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.review = review;
    this.cwd = cwd;
    this.done = done;
    this.signal = signal;
    this.answers = new Map(initialAnswers.map((answer) => [answer.stageId, answer]));
    this.editorTheme = editorTheme(theme);
    this.editor = new Editor(tui, this.editorTheme);
    this.imageMode = canRenderImages() && review.stages.some((stage) => stage.options.some((option) => option.image));
    this.editor.onSubmit = (value) => this.submitEditor(value);
    void loadOptionImages(review, cwd, signal).then((loaded) => {
      if (this.disposed) return;
      this.loadedImages.clear();
      for (const [key, value] of loaded) this.loadedImages.set(key, value);
      this.invalidate();
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = undefined;
    this.editor.invalidate();
    this.requestRender();
  }

  setRenderRequest(request: () => void): void {
    (this as { requestRender: () => void }).requestRender = request;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.inputMode !== "none") {
      if (matchesKey(data, Key.escape)) {
        this.inputMode = "none";
        this.editor.setText("");
        this.invalidate();
        return;
      }
      this.editor.handleInput(data);
      this.invalidate();
      return;
    }
    const stage = this.review.stages[this.stageIndex];
    if (!stage) return;
    const rows = rowsForStage(stage);
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = (this.selectedIndex - 1 + rows.length) % rows.length;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % rows.length;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.stageIndex = (this.stageIndex + 1) % this.review.stages.length;
      this.selectedIndex = 0;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.stageIndex = (this.stageIndex - 1 + this.review.stages.length) % this.review.stages.length;
      this.selectedIndex = 0;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done({ version: 1, reviewId: this.review.reviewId, round: this.review.round, status: "cancelled", decision: "cancel", cancelled: true, answers: [...this.answers.values()] });
      return;
    }
    if (!matchesKey(data, Key.enter)) return;
    const row = rows[this.selectedIndex];
    if (!row) return;
    if (row.kind === "other") {
      this.inputMode = "other";
      this.inputStageIndex = this.stageIndex;
      this.editor.setText("");
      this.invalidate();
      return;
    }
    if (row.kind === "revision") {
      this.inputMode = "revision";
      this.inputStageIndex = this.stageIndex;
      this.editor.setText("");
      this.invalidate();
      return;
    }
    if (row.kind !== "option") return;
    const answer = makeOptionAnswer(stage, this.stageIndex, [row.option]);
    this.answers.set(stage.id, answer);
    this.advanceAfterAnswer();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const safeWidth = Math.max(20, width);
    const stage = this.review.stages[this.stageIndex];
    if (!stage) return [];
    const lines: string[] = [];
    const add = (text = "") => lines.push(text);
    const addWrapped = (text: string, indent = 0) => {
      const prefix = " ".repeat(indent);
      const wrapped = wrapTextWithAnsi(text, Math.max(1, safeWidth - indent));
      for (const [index, line] of wrapped.entries()) lines.push(`${index === 0 ? prefix : prefix}${line}`);
    };
    const border = (text: string) => this.theme.fg("borderAccent", text);
    add(border("─".repeat(safeWidth)));
    const title = this.review.title ?? "Visual review";
    add(this.theme.fg("accent", this.theme.bold(`${title}  (round ${this.review.round})`)));
    add("");
    const tabs = this.review.stages.map((item, index) => {
      const active = index === this.stageIndex;
      const answered = this.answers.has(item.id);
      const marker = answered ? "✓" : "□";
      const raw = ` ${marker} ${item.header} `;
      return active ? this.theme.bg("selectedBg", this.theme.fg("text", raw)) : this.theme.fg(answered ? "success" : "muted", raw);
    });
    add(` ${tabs.join(" ")} `);
    add("");
    addWrapped(this.theme.fg("text", stage.prompt), 1);
    if (stage.description) {
      add("");
      addWrapped(this.theme.fg("muted", stage.description), 1);
    }
    add("");

    if (this.inputMode !== "none") {
      const prompt = this.inputMode === "revision" ? "Describe the revision you want:" : "Type your answer:";
      add(this.theme.fg("accent", prompt));
      add("");
      for (const line of this.editor.render(Math.max(1, safeWidth - 4))) lines.push(`  ${line}`);
      add("");
      add(this.theme.fg("dim", "Enter to submit • Esc to cancel"));
    } else {
      const rows = rowsForStage(stage);
      const leftWidth = this.imageMode && safeWidth >= 80 ? Math.min(34, Math.max(24, Math.floor(safeWidth * 0.3))) : safeWidth - 2;
      const list = new SelectList(
        rows.map((row) => ({ value: row.kind === "option" ? row.option.id : row.kind, label: rowLabel(row), description: rowDescription(row) })),
        Math.min(8, Math.max(3, rows.length)),
        selectTheme(this.theme),
        { minPrimaryColumnWidth: Math.min(30, leftWidth - 2), maxPrimaryColumnWidth: Math.min(38, leftWidth - 2) },
      );
      list.setSelectedIndex(this.selectedIndex);
      const listLines = list.render(leftWidth);
      if (this.imageMode && safeWidth >= 80) {
        const rightWidth = safeWidth - leftWidth - 3;
        const imageStage = this.selectedImageOption(stage);
        const left = new HStack([{ component: new Text(listLines.join("\n"), 0, 0), basis: leftWidth, shrink: 0 }], { gap: 0 });
        const rightLines = imageStage ? this.renderSelectedVisual(imageStage, rightWidth) : this.renderFallbackPanel(stage, rightWidth);
        const right = new Text(rightLines.join("\n"), 0, 0);
        const combined = new HStack([{ component: left, basis: leftWidth, shrink: 0 }, { component: right, basis: rightWidth, shrink: 0 }], { gap: 3 });
        lines.push(...combined.render(safeWidth - 2).map((line) => ` ${line}`));
      } else {
        for (const line of listLines) lines.push(` ${line}`);
        const selected = rows[this.selectedIndex];
        if (selected?.kind === "option") {
          lines.push("");
          for (const line of this.renderSelectedVisual(selected.option, safeWidth - 4)) lines.push(`  ${line}`);
        }
      }
      add("");
      const current = answerForStage(this.answers, stage);
      if (current) {
        add(this.theme.fg("success", `Current answer: ${current.answer ?? current.optionLabels?.join(", ") ?? "(empty)"}`));
      }
      add(this.theme.fg("dim", "↑↓ move • Enter choose • Tab/←→ stages • Esc cancel"));
    }
    add("");
    add(border("─".repeat(safeWidth)));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private selectedImageOption(stage: NormalizedStage): NormalizedOption | undefined {
    const rows = rowsForStage(stage);
    const row = rows[this.selectedIndex];
    return row?.kind === "option" ? row.option : undefined;
  }

  private renderSelectedVisual(option: NormalizedOption, width: number): string[] {
    const key = `${this.review.stages[this.stageIndex].id}:${option.id}`;
    const loaded = this.loadedImages.get(key);
    if (this.imageMode && loaded?.image) {
      return [this.theme.fg("accent", `Preview: ${option.label}`), "", ...imageLines(loaded.image, this.theme, width)];
    }
    return [this.theme.fg("accent", `Preview: ${option.label}`), "", ...fallbackPreview(option, loaded, this.theme)];
  }

  private renderFallbackPanel(stage: NormalizedStage, width: number): string[] {
    const selected = rowsForStage(stage)[this.selectedIndex];
    if (selected?.kind === "option") return this.renderSelectedVisual(selected.option, width);
    return [this.theme.fg("dim", "Select an option to inspect its preview."), "", ...(stage.options.slice(0, 2).flatMap((option) => [`${option.label}: ${option.description ?? ""}`, ...(option.preview ? [option.preview] : [])]))),];
  }

  private submitEditor(value: string): void {
    if (this.inputMode === "none") return;
    const stage = this.review.stages[this.inputStageIndex];
    if (!stage) return;
    const text = value.trim();
    if (this.inputMode === "revision") {
      if (!text) {
        this.inputMode = "none";
        this.invalidate();
        return;
      }
      const revision: ReviewRevision = { stageId: stage.id, stageIndex: this.inputStageIndex, feedback: text, requestedRound: this.review.round + 1 };
      this.done({ version: 1, reviewId: this.review.reviewId, round: this.review.round, status: "revision", decision: "revision", cancelled: false, answers: [...this.answers.values()], revision });
      return;
    }
    const answer = makeCustomAnswer(stage, this.inputStageIndex, text);
    this.answers.set(stage.id, answer);
    this.inputMode = "none";
    this.editor.setText("");
    this.advanceAfterAnswer();
  }

  private advanceAfterAnswer(): void {
    const current = this.review.stages[this.stageIndex];
    const next = this.review.stages[this.stageIndex + 1];
    if (next) {
      this.stageIndex += 1;
      this.selectedIndex = 0;
      this.invalidate();
      return;
    }
    if (current && this.review.stages.every((stage) => this.answers.has(stage.id))) {
      this.finishApproved();
    } else {
      this.stageIndex = 0;
      this.selectedIndex = 0;
      this.invalidate();
    }
  }

  private finishApproved(): void {
    this.done({ version: 1, reviewId: this.review.reviewId, round: this.review.round, status: "completed", decision: "approve", cancelled: false, answers: [...this.answers.values()] });
  }
}

export async function runVisualReviewWizard(
  ctx: ExtensionContext,
  review: NormalizedReview,
  initialAnswers: ReviewAnswer[] = [],
): Promise<ReviewResult> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    const { makeFallbackResult } = await import("./fallback.ts");
    return makeFallbackResult(review, ctx.hasUI ? "no_custom_ui" : "no_ui");
  }
  return ctx.ui.custom<ReviewResult>((tui, theme, _keybindings, done) => {
    const wizard = new VisualReviewWizard(tui, theme, review, ctx.cwd, done, initialAnswers, ctx.signal);
    // The factory callback is intentionally kept free of closure allocation in render.
    return wizard;
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "bottom-center",
      width: "100%",
      maxHeight: "100%",
      margin: { left: 0, right: 0, bottom: 0 },
    },
  });
}
