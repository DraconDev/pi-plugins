import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  HStack,
  Image,
  Key,
  type Component,
  type EditorTheme,
  matchesKey,
  Text,
  type TUI,
  wrapTextWithAnsi,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { canRenderImages, imageFileLink, loadImage, type LoadedImage } from "./image-loader.ts";
import type { NormalizedOption, NormalizedReview, NormalizedStage } from "./schema.ts";
import {
  isStageAnswered,
  makeCustomAnswer,
  makeOptionAnswer,
  makeReviewResult,
  unresolvedStages,
  type ReviewAnswer,
  type ReviewResult,
  type ReviewRevision,
  selectedOptions,
} from "./state.ts";

interface LoadedOption {
  image?: LoadedImage;
  error?: string;
}

type Row =
  | { kind: "option"; option: NormalizedOption }
  | { kind: "done" }
  | { kind: "other" }
  | { kind: "skip" }
  | { kind: "revision" }
  | { kind: "approve" }
  | { kind: "reject" };

export interface VisualReviewWizardOptions {
  review: NormalizedReview;
  cwd: string;
  initialAnswers?: readonly ReviewAnswer[];
  initialSkippedStageIds?: readonly string[];
  signal?: AbortSignal;
}

const OTHER_LABEL = "Type something.";
const REVISION_LABEL = "Request revision";
const DONE_LABEL = "Done selecting";
const SKIP_LABEL = "Skip stage";
const APPROVE_LABEL = "Approve review";
const REJECT_LABEL = "Reject review";

function editorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
}

function rowsForStage(stage: NormalizedStage): Row[] {
  const rows: Row[] = stage.options.map((option) => ({ kind: "option", option }));
  if (stage.multiSelect) rows.push({ kind: "done" });
  if (stage.allowOther) rows.push({ kind: "other" });
  if (!stage.required) rows.push({ kind: "skip" });
  if (stage.allowRevision) rows.push({ kind: "revision" });
  rows.push({ kind: "approve" }, { kind: "reject" });
  return rows;
}

function rowLabel(row: Row): string {
  if (row.kind === "option") return row.option.label;
  if (row.kind === "done") return DONE_LABEL;
  if (row.kind === "other") return OTHER_LABEL;
  if (row.kind === "skip") return SKIP_LABEL;
  if (row.kind === "revision") return REVISION_LABEL;
  return row.kind === "approve" ? APPROVE_LABEL : REJECT_LABEL;
}

function rowDescription(row: Row): string | undefined {
  if (row.kind === "option") return row.option.description;
  if (row.kind === "done") return "Commit the checked options";
  if (row.kind === "revision") return "Describe changes, then return to the model for regeneration";
  if (row.kind === "approve") return "Approve the review and continue";
  if (row.kind === "reject") return "Reject this proposal without changing it";
  if (row.kind === "skip") return "Continue without answering this optional stage";
  return "Enter a custom response";
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
          if (!signal?.aborted) loaded.set(key, { error: errorMessage(error) });
        }
      }),
    ),
  );
  return loaded;
}

function isImageLine(line: string): boolean {
  return line.includes("\u001b_G") || line.includes("\u001b]1337;File=");
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "…");
}

function imageLines(image: LoadedImage, theme: Theme, width: number, maxHeight = 16): string[] {
  const component = new Image(
    image.base64,
    image.mimeType,
    { fallbackColor: (text) => theme.fg("muted", text) },
    {
      maxWidthCells: Math.max(1, width - 2),
      maxHeightCells: maxHeight,
      filename: image.filename,
    },
    image.dimensions,
  );
  return component.render(Math.max(1, width));
}

/** Readable text fallback used when inline images are unavailable, loading, or failed. */
function fallbackPreview(option: NormalizedOption, loaded: LoadedOption | undefined, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  const source = option.image?.path ?? option.image?.url;
  if (source) {
    const label = loaded?.error ? `Image unavailable: ${loaded.error}` : `Image: ${imageFileLink(source)}`;
    lines.push(...wrapTextWithAnsi(theme.fg("muted", label), width));
  }
  if (option.image?.alt) lines.push(...wrapTextWithAnsi(theme.fg("dim", `Alt: ${option.image.alt}`), width));
  if (option.preview) lines.push(...wrapTextWithAnsi(option.preview, width));
  if (!source && !option.preview) lines.push(theme.fg("dim", "No inline preview supplied."));
  return lines;
}

function resultFor(
  review: NormalizedReview,
  decision: "approve" | "reject" | "cancel" | "revision",
  answers: Map<string, ReviewAnswer>,
  skippedStageIds: ReadonlySet<string>,
  revision?: ReviewRevision,
): ReviewResult {
  return makeReviewResult(review, decision, answers, revision, [...skippedStageIds]);
}

export class VisualReviewWizard implements Component {
  private readonly review: NormalizedReview;
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly done: (result: ReviewResult) => void;
  private readonly cwd: string;
  private readonly signal?: AbortSignal;
  private readonly answers = new Map<string, ReviewAnswer>();
  private readonly skippedStageIds = new Set<string>();
  /** Per-stage selection state is updated by Space/Enter before a multi-select stage is confirmed. */
  private readonly selections = new Map<string, Set<string>>();
  private readonly loadedImages = new Map<string, LoadedOption>();
  private readonly editor: Editor;
  private readonly imageMode: boolean;
  private stageIndex = 0;
  private selectedIndex = 0;
  private inputMode: "none" | "other" | "revision" = "none";
  private inputStageIndex = 0;
  private cachedWidth = -1;
  private cachedLines: string[] | undefined;
  private disposed = false;
  private finished = false;

  constructor(
    tui: TUI,
    theme: Theme,
    review: NormalizedReview,
    cwd: string,
    done: (result: ReviewResult) => void,
    initialAnswers: readonly ReviewAnswer[] = [],
    signal?: AbortSignal,
    initialSkippedStageIds: readonly string[] = [],
  ) {
    this.review = review;
    this.theme = theme;
    this.cwd = cwd;
    this.done = done;
    this.signal = signal;
    this.requestRender = () => tui.requestRender();
    this.editor = new Editor(tui, editorTheme(theme));
    this.editor.focused = true;
    this.editor.onSubmit = (value) => this.submitEditor(value);

    for (const [stageIndex, stage] of review.stages.entries()) {
      const answer = initialAnswers.find((candidate) => candidate.stageId === stage.id);
      if (answer && isStageAnswered(stage, stageIndex, answer)) {
        const resumedAnswer: ReviewAnswer = { ...answer, stageId: stage.id, stageIndex };
        this.answers.set(stage.id, resumedAnswer);
        this.selections.set(
          stage.id,
          stage.multiSelect && resumedAnswer.kind === "multi" && resumedAnswer.optionIds
            ? new Set(resumedAnswer.optionIds)
            : new Set(),
        );
      } else {
        this.selections.set(stage.id, new Set());
      }
      if (!stage.required && initialSkippedStageIds.includes(stage.id) && !this.answers.has(stage.id)) {
        this.skippedStageIds.add(stage.id);
      }
    }

    this.imageMode = canRenderImages() && review.stages.some((stage) => stage.options.some((option) => option.image));
    if (this.signal?.aborted) this.onAbort();
    else this.signal?.addEventListener("abort", this.onAbort, { once: true });
    void loadOptionImages(review, cwd, signal).then((loaded) => {
      if (this.disposed || this.finished) return;
      this.loadedImages.clear();
      for (const [key, value] of loaded) this.loadedImages.set(key, value);
      this.invalidate();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.editor.setText("");
    this.editor.focused = false;
  }

  private readonly onAbort = (): void => {
    if (this.finished) return;
    this.finish(resultFor(this.review, "cancel", this.answers, this.skippedStageIds));
  };

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = undefined;
    this.editor.invalidate();
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.disposed || this.finished || this.signal?.aborted) return;

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
    if (!rows.length) return;

    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
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
      this.finish(resultFor(this.review, "cancel", this.answers, this.skippedStageIds));
      return;
    }

    const row = rows[this.selectedIndex];
    if (!row) return;
    if (row.kind === "approve") {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
        const missing = unresolvedStages(this.review, this.answers, [...this.skippedStageIds])[0];
        if (missing) {
          this.stageIndex = this.review.stages.indexOf(missing);
          this.selectedIndex = 0;
          this.invalidate();
          return;
        }
        this.finish(resultFor(this.review, "approve", this.answers, this.skippedStageIds));
      }
      return;
    }
    if (row.kind === "reject") {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) this.finish(resultFor(this.review, "reject", this.answers, this.skippedStageIds));
      return;
    }
      if (row.kind === "other" || row.kind === "revision" || row.kind === "skip") {
      if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.space)) return;
      if (row.kind === "skip") {
        this.answers.delete(stage.id);
        this.skippedStageIds.add(stage.id);
        this.advanceAfterAnswer();
        return;
      }
      this.inputMode = row.kind === "other" ? "other" : "revision";
      this.inputStageIndex = this.stageIndex;
      this.editor.setText("");
      this.invalidate();
      return;
    }
    if (row.kind !== "option" && row.kind !== "done") return;

    if (stage.multiSelect) {
      if (!matchesKey(data, Key.space) && !matchesKey(data, Key.enter)) return;
      const selected = this.selection(stage.id);
      if (row.kind === "done") {
        if (selected.size === 0) return;
        const options = stage.options.filter((option) => selected.has(option.id));
        this.answers.set(stage.id, makeOptionAnswer(stage, this.stageIndex, options));
        this.skippedStageIds.delete(stage.id);
        this.advanceAfterAnswer();
        return;
      }
      if (matchesKey(data, Key.space)) {
        if (selected.has(row.option.id)) selected.delete(row.option.id);
        else selected.add(row.option.id);
        this.invalidate();
        return;
      }
      if (selected.size === 0) return;
      const options = stage.options.filter((option) => selected.has(option.id));
      this.answers.set(stage.id, makeOptionAnswer(stage, this.stageIndex, options));
      this.skippedStageIds.delete(stage.id);
      this.advanceAfterAnswer();
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      if (row.kind !== "option") return;
      this.answers.set(stage.id, makeOptionAnswer(stage, this.stageIndex, [row.option]));
      this.skippedStageIds.delete(stage.id);
      this.advanceAfterAnswer();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const safeWidth = Math.max(20, width);
    const stage = this.review.stages[this.stageIndex];
    if (!stage) return [];
    const lines: string[] = [];
    const border = (text: string) => this.theme.fg("borderAccent", text);
    const addWrapped = (text: string, indent = 1) => {
      const wrapped = wrapTextWithAnsi(text, Math.max(1, safeWidth - indent));
      for (const line of wrapped) lines.push(`${" ".repeat(indent)}${line}`);
    };

    lines.push(border("─".repeat(safeWidth)));
    const title = this.review.title ?? "Visual review";
    lines.push(this.theme.fg("accent", this.theme.bold(`${title}  (round ${this.review.round})`)));
    lines.push("");
    const tabs = this.review.stages.map((item, index) => {
      const active = index === this.stageIndex;
      const answered = this.answers.has(item.id);
      const raw = ` ${answered ? "✓" : "□"} ${item.header} `;
      return active ? this.theme.bg("selectedBg", this.theme.fg("text", raw)) : this.theme.fg(answered ? "success" : "muted", raw);
    });
    lines.push(` ${tabs.join(" ")} `);
    lines.push("");
    addWrapped(stage.prompt);
    if (stage.description) {
      lines.push("");
      addWrapped(this.theme.fg("muted", stage.description));
    }
    lines.push("");

    if (this.inputMode !== "none") {
      lines.push(this.theme.fg("accent", this.inputMode === "revision" ? "Describe the revision you want:" : "Type your answer:"));
      lines.push("");
      for (const line of this.editor.render(Math.max(1, safeWidth - 4))) lines.push(`  ${line}`);
      lines.push("");
      lines.push(this.theme.fg("dim", "Enter to submit • Esc to go back"));
    } else {
      const rows = rowsForStage(stage);
      const leftWidth = this.imageMode && safeWidth >= 88 ? Math.min(36, Math.max(26, Math.floor(safeWidth * 0.3))) : safeWidth - 2;
      const listLines = this.renderRows(stage, rows, leftWidth);
      if (this.imageMode && safeWidth >= 88) {
        const rightWidth = safeWidth - leftWidth - 3;
        const left = new Text(listLines.join("\n"), 0, 0);
        const selected = rows[this.selectedIndex];
        const rightLines = selected?.kind === "option" ? this.renderSelectedVisual(selected.option, rightWidth) : [
          this.theme.fg("dim", "Select an option to inspect its image."),
          "",
          ...stage.options.slice(0, 2).flatMap((option) => [`${option.label}: ${option.description ?? ""}`]),
        ];
        const right = new Text(rightLines.join("\n"), 0, 0);
        // Image.render() returns protocol lines which must not be wrapped or padded as text.
        // HStack/TUI composition recognizes these lines and preserves their escape sequences.
        const combined = new HStack(
          [
            { component: left, basis: leftWidth, shrink: 0 },
            { component: right, basis: rightWidth, shrink: 0 },
          ],
          { gap: 3 },
        );
        for (const line of combined.render(Math.max(1, safeWidth - 2))) {
          if (isImageLine(line)) lines.push(line);
          else lines.push(` ${line}`);
        }
      } else {
        for (const line of listLines) lines.push(` ${line}`);
        const selected = rows[this.selectedIndex];
        if (selected?.kind === "option") {
          lines.push("");
          for (const line of this.renderSelectedVisual(selected.option, safeWidth - 4)) {
            if (isImageLine(line)) lines.push(line);
            else lines.push(`  ${line}`);
          }
        }
      }
      lines.push("");
      const current = this.answers.get(stage.id);
      if (current) lines.push(this.theme.fg("success", `Current answer: ${current.answer ?? current.optionLabels?.join(", ") ?? "(empty)"}`));
      const selection = this.selection(stage.id);
      const help = stage.multiSelect
        ? `↑↓ move • Space toggle • Enter confirm • Tab stages • Esc cancel`
        : "↑↓ move • Enter select • Tab/←→ stages • Esc cancel";
      lines.push(this.theme.fg("dim", help));
      if (stage.multiSelect && selection.size > 0) {
        lines.push(this.theme.fg("accent", `Selected: ${stage.options.filter((option) => selection.has(option.id)).map((option) => option.label).join(", ")}`));
      }
    }

    lines.push("");
    lines.push(border("─".repeat(safeWidth)));
    const bounded = lines.map((line) => isImageLine(line) ? line : fitLine(line, safeWidth));
    this.cachedWidth = width;
    this.cachedLines = bounded;
    return bounded;
  }

  private selection(stageId: string): Set<string> {
    let selected = this.selections.get(stageId);
    if (!selected) {
      selected = new Set();
      this.selections.set(stageId, selected);
    }
    return selected;
  }

  private renderRows(stage: NormalizedStage, rows: readonly Row[], width: number): string[] {
    const lines: string[] = [];
    const selected = this.selection(stage.id);
    rows.forEach((row, index) => {
      const active = index === this.selectedIndex;
      const marker = row.kind === "option" && stage.multiSelect ? (selected.has(row.option.id) ? "✓ " : "  ") : "";
      const prefix = active ? this.theme.fg("accent", "> ") : "  ";
      const label = `${marker}${rowLabel(row)}`;
      lines.push(...wrapTextWithAnsi(`${prefix}${label}`, Math.max(1, width)));
      if (rowDescription(row)) {
        for (const line of wrapTextWithAnsi(this.theme.fg("muted", `     ${rowDescription(row)}`), Math.max(1, width))) {
          lines.push(line);
        }
      }
    });
    return lines;
  }

  private renderSelectedVisual(option: NormalizedOption, width: number): string[] {
    const stage = this.review.stages[this.stageIndex];
    const key = `${stage.id}:${option.id}`;
    const loaded = this.loadedImages.get(key);
    if (this.imageMode && loaded?.image) {
      return [this.theme.fg("accent", `Preview: ${option.label}`), "", ...imageLines(loaded.image, this.theme, width)];
    }
    return [this.theme.fg("accent", `Preview: ${option.label}`), "", ...fallbackPreview(option, loaded, this.theme, Math.max(1, width))];
  }

  private submitEditor(value: string): void {
    if (this.inputMode === "none" || this.finished) return;
    const stage = this.review.stages[this.inputStageIndex];
    if (!stage) return;
    const text = value.trim();
    if (this.inputMode === "revision") {
      if (!text) {
        this.inputMode = "none";
        this.editor.setText("");
        this.invalidate();
        return;
      }
      const revision: ReviewRevision = {
        stageId: stage.id,
        stageIndex: this.inputStageIndex,
        feedback: text,
        requestedRound: this.review.round + 1,
      };
      this.finish(resultFor(this.review, "revision", this.answers, this.skippedStageIds, revision));
      return;
    }
    if (!text) {
      this.inputMode = "none";
      this.editor.setText("");
      this.invalidate();
      return;
    }
    this.answers.set(stage.id, makeCustomAnswer(stage, this.inputStageIndex, text));
    this.skippedStageIds.delete(stage.id);
    this.inputMode = "none";
    this.editor.setText("");
    this.advanceAfterAnswer();
  }

  private advanceAfterAnswer(): void {
    const next = this.review.stages[this.stageIndex + 1];
    if (next) {
      this.stageIndex += 1;
      this.selectedIndex = 0;
      this.invalidate();
      return;
    }
    const missingStage = unresolvedStages(this.review, this.answers, [...this.skippedStageIds])[0];
    if (missingStage) {
      this.stageIndex = this.review.stages.indexOf(missingStage);
      this.selectedIndex = 0;
      this.invalidate();
      return;
    }
    const approveRow = rowsForStage(this.review.stages[this.stageIndex]).findIndex((row) => row.kind === "approve");
    this.selectedIndex = Math.max(0, approveRow);
    this.invalidate();
  }

  private finish(result: ReviewResult): void {
    if (this.finished) return;
    this.finished = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.editor.setText("");
    this.editor.focused = false;
    this.done(result);
  }
}

export async function runVisualReviewWizard(
  ctx: ExtensionContext,
  review: NormalizedReview,
  initialAnswers: readonly ReviewAnswer[] = [],
  initialSkippedStageIds: readonly string[] = [],
): Promise<ReviewResult> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    const { makeFallbackResult } = await import("./fallback.ts");
    return makeFallbackResult(review, ctx.hasUI ? "no_custom_ui" : "no_ui");
  }
  return ctx.ui.custom<ReviewResult>((tui, theme, _keybindings, done) => {
    return new VisualReviewWizard(tui, theme, review, ctx.cwd, done, initialAnswers, ctx.signal, initialSkippedStageIds);
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

export { selectedOptions };
