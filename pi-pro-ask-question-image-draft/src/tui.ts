import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { editWithExternalEditor } from "./external-editor.ts";
import {
  Editor,
  HStack,
  Image,
  Key,
  type Component,
  type EditorTheme,
  type Focusable,
  type KeyId,
  Markdown,
  type MarkdownTheme,
  type OverlayHandle,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  wrapTextWithAnsi,
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
  | { kind: "note" }
  | { kind: "skip" }
  | { kind: "revision" }
  | { kind: "edit" }
  | { kind: "globalNote" }
  | { kind: "approve" }
  | { kind: "reject" };

export interface VisualReviewWizardOptions {
  review: NormalizedReview;
  cwd: string;
  initialAnswers?: readonly ReviewAnswer[];
  initialSkippedStageIds?: readonly string[];
  initialGlobalNote?: string;
  signal?: AbortSignal;
}

const OTHER_LABEL = "Type something.";
const REVISION_LABEL = "Request revision";
const DONE_LABEL = "Done selecting";
const SKIP_LABEL = "Skip stage";
const APPROVE_LABEL = "Approve review";
const REJECT_LABEL = "Reject review";
const NOTE_LABEL = "Add note";
const EDIT_LABEL = "Edit answers";
const GLOBAL_NOTE_LABEL = "Add global note";

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

function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.bold(theme.fg("mdHeading", text)),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
    codeBlockIndent: "  ",
  };
}

function rowsForStage(stage: NormalizedStage): Row[] {
  const rows: Row[] = stage.options.map((option) => ({ kind: "option", option }));
  if (stage.multiSelect) rows.push({ kind: "done" });
  if (stage.allowOther) rows.push({ kind: "other" });
  if (!stage.required) rows.push({ kind: "skip" });
  if (stage.allowRevision) rows.push({ kind: "revision" });
  return rows;
}

function noteForCurrentRow(row: Row | undefined, stage: NormalizedStage | undefined, answers: ReadonlyMap<string, ReviewAnswer>): string | undefined {
  if (!stage || !row) return undefined;
  return row.kind === "option" || row.kind === "done" || row.kind === "other" || row.kind === "skip" || row.kind === "revision"
    ? answers.get(stage.id)?.notes
    : undefined;
}

function rowsForReview(): Row[] {
  return [
    { kind: "edit" },
    { kind: "globalNote" },
    { kind: "approve" },
    { kind: "reject" },
  ];
}

function rowLabel(row: Row): string {
  if (row.kind === "option") return row.option.label;
  if (row.kind === "done") return DONE_LABEL;
  if (row.kind === "other") return OTHER_LABEL;
  if (row.kind === "note") return NOTE_LABEL;
  if (row.kind === "skip") return SKIP_LABEL;
  if (row.kind === "revision") return REVISION_LABEL;
  if (row.kind === "edit") return EDIT_LABEL;
  if (row.kind === "globalNote") return GLOBAL_NOTE_LABEL;
  return row.kind === "approve" ? APPROVE_LABEL : REJECT_LABEL;
}

function rowDescription(row: Row): string | undefined {
  if (row.kind === "option") return row.option.description;
  if (row.kind === "done") return "Commit the checked options";
  if (row.kind === "note") return "Attach a note to this stage without answering it";
  if (row.kind === "revision") return "Describe changes, then return to the model for regeneration";
  if (row.kind === "edit") return "Return to the first unanswered stage";
  if (row.kind === "globalNote") return "Attach a note to the complete review";
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
  if (option.preview) {
    const markdown = new Markdown(option.preview, 1, 0, markdownTheme(theme), undefined, { renderLatex: false });
    lines.push(...markdown.render(Math.max(1, width)));
  }
  if (!source && !option.preview) lines.push(theme.fg("dim", "No inline preview supplied."));
  return lines;
}

function resultFor(
  review: NormalizedReview,
  decision: "approve" | "reject" | "cancel" | "revision",
  answers: Map<string, ReviewAnswer>,
  skippedStageIds: ReadonlySet<string>,
  revision?: ReviewRevision,
  globalNote?: string,
): ReviewResult {
  return makeReviewResult(review, decision, answers, revision, [...skippedStageIds], globalNote);
}

class LinesComponent implements Component {
  private readonly lines: readonly string[];
  constructor(lines: readonly string[]) { this.lines = lines; }
  render(): string[] { return [...this.lines]; }
  invalidate(): void {}
}

export class VisualReviewWizard implements Component, Focusable {
  private readonly review: NormalizedReview;
  private readonly theme: Theme;
  private readonly keybindings?: KeybindingsManager;
  private readonly requestRender: () => void;
  private readonly tui: TUI;
  private readonly done: (result: ReviewResult) => void;
  private readonly cwd: string;
  private readonly signal?: AbortSignal;
  private readonly externalEditorConfigured: boolean;
  private readonly answers = new Map<string, ReviewAnswer>();
  private readonly notesByStage = new Map<string, string>();
  private readonly skippedStageIds = new Set<string>();
  /** Per-stage selection state is updated by Space/Enter before a multi-select stage is confirmed. */
  private readonly selections = new Map<string, Set<string>>();
  private readonly loadedImages = new Map<string, LoadedOption>();
  private readonly editor: Editor;
  private readonly editExternal?: (value: string) => Promise<string | undefined>;
  private overlayHandle?: OverlayHandle;
  private readonly imageMode: boolean;
  private collapsed = false;
  private _focused = false;
  private stageIndex = 0;
  private selectedIndex = 0;
  private inputMode: "none" | "other" | "revision" | "note" | "globalNote" = "none";
  private inputStageIndex = 0;
  private globalNote = "";
  private cachedWidth = -1;
  private cachedHeight = -1;
  private cachedLines: string[] | undefined;
  private scrollOffset = 0;
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
    initialGlobalNote = "",
    keybindings?: KeybindingsManager,
    editExternal?: (value: string) => Promise<string | undefined>,
  ) {
    this.review = review;
    this.theme = theme;
    this.keybindings = keybindings;
    this.editExternal = editExternal;
    this.externalEditorConfigured = Boolean(editExternal);
    this.tui = tui;
    this.cwd = cwd;
    this.done = done;
    this.signal = signal;
    this.requestRender = () => tui.requestRender();
    this.globalNote = initialGlobalNote;
    this.editor = new Editor(tui, editorTheme(theme));
    this.editor.focused = true;
    this.editor.disableSubmit = true;

    for (const [stageIndex, stage] of review.stages.entries()) {
      const answer = initialAnswers.find((candidate) => candidate.stageId === stage.id);
      if (answer && isStageAnswered(stage, stageIndex, answer)) {
        const resumedAnswer: ReviewAnswer = { ...answer, stageId: stage.id, stageIndex };
        this.answers.set(stage.id, resumedAnswer);
        if (resumedAnswer.notes) this.notesByStage.set(stage.id, resumedAnswer.notes);
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

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    if (!value && this.collapsed) this.overlayHandle?.setHidden(true);
    this.editor.focused = value && this.inputMode !== "none";
  }

  dispose(): void {
    this.disposed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.editor.setText("");
    this.editor.focused = false;
  }

  private readonly onAbort = (): void => {
    if (this.finished) return;
    this.finish(resultFor(this.review, "cancel", this.answers, this.skippedStageIds, undefined, this.globalNote));
  };

  private async editExternalAnswer(): Promise<void> {
    if (!this.editExternal || this.finished) return;
    const edited = await this.editExternal(this.editor.getText());
    if (edited === undefined || this.finished) return;
    this.editor.setText(edited);
    this.invalidate();
  }

  private get isReviewTab(): boolean {
    return this.stageIndex >= this.review.stages.length;
  }

  private currentStage(): NormalizedStage | undefined {
    return this.review.stages[this.stageIndex];
  }

  private currentRows(): Row[] {
    const stage = this.currentStage();
    return stage ? rowsForStage(stage) : rowsForReview();
  }

  private matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel" | "tui.input.submit" | "tui.input.newLine", fallback: KeyId): boolean {
    return this.keybindings ? this.keybindings.matches(data, binding) : matchesKey(data, fallback);
  }

  private isConfirm(data: string): boolean {
    return this.matches(data, "tui.select.confirm", Key.enter) || this.matches(data, "tui.input.submit", Key.enter);
  }

  private isCancel(data: string): boolean {
    return this.matches(data, "tui.select.cancel", Key.escape);
  }

  private storeAnswer(stageId: string, answer: ReviewAnswer): void {
    const note = this.notesByStage.get(stageId);
    this.answers.set(stageId, note ? { ...answer, notes: note } : answer);
  }

  private setStageNote(stageId: string, note: string): void {
    if (note) this.notesByStage.set(stageId, note);
    else this.notesByStage.delete(stageId);
    const answer = this.answers.get(stageId);
    if (answer) this.answers.set(stageId, note ? { ...answer, notes: note } : { ...answer, notes: undefined });
  }

  private currentNote(): string | undefined {
    const stage = this.currentStage();
    if (!stage) return undefined;
    const row = this.currentRows()[this.selectedIndex];
    if (!row) return undefined;
    return this.notesByStage.get(stage.id) ?? noteForCurrentRow(row, stage, this.answers);
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedHeight = -1;
    this.cachedLines = undefined;
    this.editor.invalidate();
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.disposed || this.finished || this.signal?.aborted) return;
    if (matchesKey(data, Key.ctrl("]"))) {
      this.toggleCollapsed();
      return;
    }

    if (this.collapsed) {
      if (this.isCancel(data)) this.finish(resultFor(this.review, "cancel", this.answers, this.skippedStageIds, undefined, this.globalNote));
      return;
    }

    if (this.inputMode !== "none") {
      if (this.isCancel(data)) {
        this.inputMode = "none";
        this.editor.setText("");
        this.editor.focused = false;
        this.invalidate();
        return;
      }
      if (this.keybindings?.matches(data, "app.editor.external") && this.inputMode === "other") {
        void this.editExternalAnswer();
        return;
      }
      if (this.isConfirm(data)) {
        this.submitEditor(this.editor.getText());
        return;
      }
      // The editor owns text editing and newline semantics. Its submit callback is
      // disabled above so a configured submit key cannot clear the buffer before
      // this component has copied it into the answer/note state.
      this.editor.handleInput(data);
      this.invalidate();
      return;
    }

    const stage = this.currentStage();
    const rows = this.currentRows();
    if (!rows.length) return;

    if (this.matches(data, "tui.select.up", Key.up)) {
      this.selectedIndex = (this.selectedIndex - 1 + rows.length) % rows.length;
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.invalidate();
      return;
    }
    if (this.matches(data, "tui.select.down", Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % rows.length;
      this.scrollOffset = Math.min(Math.max(0, this.scrollOffset + 1), Math.max(0, rows.length - 1));
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.stageIndex = (this.stageIndex + 1) % (this.review.stages.length + 1);
      this.selectedIndex = 0;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.stageIndex = (this.stageIndex - 1 + this.review.stages.length + 1) % (this.review.stages.length + 1);
      this.selectedIndex = 0;
      this.invalidate();
      return;
    }
    if (this.isCancel(data)) {
      this.finish(resultFor(this.review, "cancel", this.answers, this.skippedStageIds, undefined, this.globalNote));
      return;
    }
    if (data === "n" || data === "\u000e") {
      if (this.isReviewTab) {
        this.inputMode = "globalNote";
        this.editor.setText(this.globalNote);
      } else {
        this.inputMode = "note";
        this.inputStageIndex = this.stageIndex;
        this.editor.setText(this.currentNote() ?? "");
      }
      this.editor.focused = this._focused;
      this.invalidate();
      return;
    }

    const row = rows[this.selectedIndex];
    if (!row) return;
    if (row.kind === "note") {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === "n") {
        if (!stage) return;
        this.inputMode = "note";
        this.inputStageIndex = this.stageIndex;
        this.editor.setText(this.currentNote() ?? "");
        this.editor.focused = this._focused;
        this.invalidate();
      }
      return;
    }
    if (row.kind === "globalNote") {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === "n") {
        this.inputMode = "globalNote";
        this.editor.setText(this.globalNote);
        this.editor.focused = this._focused;
        this.invalidate();
      }
      return;
    }
    if (row.kind === "edit") {
      if (this.isConfirm(data) || data === " ") {
        const missing = unresolvedStages(this.review, this.answers, [...this.skippedStageIds])[0];
        this.stageIndex = missing ? this.review.stages.indexOf(missing) : 0;
        this.selectedIndex = 0;
        this.invalidate();
      }
      return;
    }
    if (row.kind === "approve") {
      if (this.isConfirm(data) || data === " ") {
        const missing = unresolvedStages(this.review, this.answers, [...this.skippedStageIds])[0];
        if (missing) {
          this.stageIndex = this.review.stages.indexOf(missing);
          this.selectedIndex = 0;
          this.invalidate();
          return;
        }
        this.finish(resultFor(this.review, "approve", this.answers, this.skippedStageIds, undefined, this.globalNote));
      }
      return;
    }
    if (row.kind === "reject") {
      if (this.isConfirm(data) || data === " ") this.finish(resultFor(this.review, "reject", this.answers, this.skippedStageIds, undefined, this.globalNote));
      return;
    }
    if (row.kind === "other" || row.kind === "revision" || row.kind === "skip") {
      if (!stage) return;
      if (!this.isConfirm(data) && data !== " ") return;
      if (row.kind === "skip") {
        this.answers.delete(stage.id);
        this.skippedStageIds.add(stage.id);
        this.advanceAfterAnswer();
        return;
      }
      this.inputMode = row.kind === "other" ? "other" : "revision";
      this.inputStageIndex = this.stageIndex;
      this.editor.setText("");
      this.editor.focused = this._focused;
      this.invalidate();
      return;
    }
    if (row.kind !== "option" && row.kind !== "done") return;
    if (!stage) return;

    if (stage.multiSelect) {
      const selected = this.selection(stage.id);
      if (row.kind === "done") {
        // The explicit commit row is the only multi-select action that advances.
        // Space remains a no-op here so it cannot accidentally commit a partial
        // selection, matching the reference questionnaire's checkbox semantics.
        if (!this.isConfirm(data) || selected.size === 0) return;
        const options = stage.options.filter((option) => selected.has(option.id));
        this.storeAnswer(stage.id, makeOptionAnswer(stage, this.stageIndex, options));
        this.skippedStageIds.delete(stage.id);
        this.advanceAfterAnswer();
        return;
      }
      if (data === " " || this.isConfirm(data)) {
        if (selected.has(row.option.id)) selected.delete(row.option.id);
        else selected.add(row.option.id);
        this.invalidate();
      }
      return;
    }

    if (this.isConfirm(data)) {
      if (row.kind !== "option") return;
      this.storeAnswer(stage.id, makeOptionAnswer(stage, this.stageIndex, [row.option]));
      this.skippedStageIds.delete(stage.id);
      this.advanceAfterAnswer();
    }
  }

  render(width: number): string[] {
    if (this.collapsed) {
      return [this.theme.fg("dim", `Visual review hidden — press Ctrl+] to reopen (${this.review.title ?? "review"})`)];
    }
    const terminalRows = this.tui.terminal?.rows;
    if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === (terminalRows ?? -1)) return this.cachedLines;
    const safeWidth = Math.max(20, width);
    const stage = this.currentStage();
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
    const reviewTab = this.isReviewTab;
    tabs.push(reviewTab ? " ✓ Review " : " □ Review ");
    lines.push(` ${tabs.join(" ")} `);
    lines.push("");
    if (stage) {
      addWrapped(stage.prompt);
      if (stage.description) {
        lines.push("");
        addWrapped(this.theme.fg("muted", stage.description));
      }
    } else {
      addWrapped(this.theme.bold("Review your answers"));
      for (const item of this.review.stages) {
        const answer = this.answers.get(item.id);
        const skipped = this.skippedStageIds.has(item.id);
        const summary = answer
          ? `${answer.answer ?? answer.optionLabels?.join(", ") ?? "(no response)"}${answer.notes ? ` — ${answer.notes}` : ""}`
          : skipped ? "Skipped" : "Outstanding";
        addWrapped(`  ${item.header}: ${summary}`, 1);
      }
      if (this.globalNote) addWrapped(`  Global note: ${this.globalNote}`, 1);
    }
    lines.push("");

    if (this.inputMode !== "none") {
      this.editor.focused = this._focused;
      const prompt = this.inputMode === "revision"
        ? "Describe the revision you want:"
        : this.inputMode === "note"
          ? "Add a note for this stage:"
          : this.inputMode === "globalNote"
            ? "Add a global note:"
            : "Type your answer:";
      lines.push(this.theme.fg("accent", prompt));
      lines.push("");
      for (const line of this.editor.render(Math.max(1, safeWidth - 4))) lines.push(`  ${line}`);
      lines.push("");
      lines.push(this.theme.fg("dim", `Enter to submit • Esc to go back${this.inputMode === "other" && this.externalEditorConfigured ? " • Ctrl+G external editor" : ""}`));
    } else {
      this.editor.focused = false;
      const rows = this.currentRows();
      const leftWidth = this.imageMode && stage && safeWidth >= 88 ? Math.min(36, Math.max(26, Math.floor(safeWidth * 0.3))) : safeWidth - 2;
      const listLines = stage ? this.renderRows(stage, rows, leftWidth) : this.renderRowsForReview(rows, leftWidth);
      if (this.imageMode && stage && safeWidth >= 88) {
        const rightWidth = Math.max(1, safeWidth - leftWidth - 5);
        const left = new LinesComponent(listLines);
        const selected = rows[this.selectedIndex];
        const rightLines = selected?.kind === "option" && stage ? this.renderSelectedVisual(selected.option, rightWidth) : [
          this.theme.fg("dim", "Select an option to inspect its image."),
          "",
          ...(stage?.options.slice(0, 2).flatMap((option) => [`${option.label}: ${option.description ?? ""}`]) ?? []),
        ];
        const right = new LinesComponent(rightLines);
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
        if (selected?.kind === "option" && stage) {
          lines.push("");
          for (const line of this.renderSelectedVisual(selected.option, safeWidth - 4)) {
            if (isImageLine(line)) lines.push(line);
            else lines.push(`  ${line}`);
          }
        }
      }
      lines.push("");
      const current = stage ? this.answers.get(stage.id) : undefined;
      if (current) lines.push(this.theme.fg("success", `Current answer: ${current.answer ?? current.optionLabels?.join(", ") ?? "(empty)"}${current.notes ? ` — ${current.notes}` : ""}`));
      const currentNote = stage ? this.currentNote() : undefined;
      if (currentNote && !current?.notes) lines.push(this.theme.fg("muted", `Note: ${currentNote}`));
      const selection = stage ? this.selection(stage.id) : new Set<string>();
      const help = stage?.multiSelect
        ? `↑↓ move • Space toggle • Enter confirm • Tab stages • Esc cancel`
        : stage ? "↑↓ move • Enter select • Tab/←→ stages • Esc cancel" : "↑↓ move • Enter review action • Tab stages • Esc cancel";
      lines.push(this.theme.fg("dim", help));
      if (stage?.multiSelect && selection.size > 0) {
        lines.push(this.theme.fg("accent", `Selected: ${stage.options.filter((option) => selection.has(option.id)).map((option) => option.label).join(", ")}`));
      }
    }

    lines.push("");
    lines.push(border("─".repeat(safeWidth)));
    const bounded = lines.map((line) => isImageLine(line) ? line : fitLine(line, safeWidth));
    const visible = this.visibleLines(bounded);
    this.cachedWidth = width;
    this.cachedHeight = terminalRows ?? -1;
    this.cachedLines = visible;
    return visible;
  }

  private toggleCollapsed(): void {
    this.setCollapsed(!this.collapsed);
  }

  /** Toggle the overlay from a raw terminal listener when Pi hides the overlay. */
  toggleCollapsedExternal(): void {
    this.toggleCollapsed();
  }

  /** Handle a raw terminal shortcut while the overlay is hidden. */
  handleTerminalInput(data: string): boolean {
    if (isKeyRelease(data) || isKeyRepeat(data)) return matchesKey(data, Key.ctrl("]"));
    if (!matchesKey(data, Key.ctrl("]"))) return false;
    this.toggleCollapsed();
    return true;
  }

  /** Set the visibility state when an overlay handle is available. */
  setCollapsed(collapsed: boolean): void {
    if (this.collapsed === collapsed) return;
    this.collapsed = collapsed;
    this.overlayHandle?.setHidden(collapsed);
    if (!collapsed) this.overlayHandle?.focus();
    this.invalidate();
  }

  setOverlayHandle(handle: OverlayHandle): void {
    this.overlayHandle = handle;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.collapsed || this.disposed || this.finished || this._focused === false) return undefined;
    if (event.type === "wheel") {
      this.scrollOffset = Math.max(0, this.scrollOffset + (event.wheelDelta ?? 0));
      this.invalidate();
      return { handled: true, render: true };
    }
    if (event.type !== "click" || event.y < 0) return undefined;
    const rowIndex = this.rowAtY(event.y, this.currentRows().length, event.width);
    if (rowIndex === undefined) return undefined;
    this.selectedIndex = rowIndex;
    this.invalidate();
    return { handled: true, focus: true, render: true };
  }

  private rowAtY(y: number, rowCount: number, width: number): number | undefined {
    if (rowCount <= 0) return undefined;
    const lines = this.cachedLines ?? this.render(width);
    const target = Math.max(0, Math.min(lines.length - 1, Math.floor(y)));
    const rowStarts: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if ((lines[index] ?? "").includes("> ")) rowStarts.push(index);
    }
    if (!rowStarts.length) return undefined;
    for (let index = rowStarts.length - 1; index >= 0; index -= 1) {
      if (rowStarts[index] <= target) return Math.min(rowCount - 1, index);
    }
    return 0;
  }

  private visibleLines(lines: string[]): string[] {
    const height = this.tui.terminal?.rows;
    if (!height || height <= 0 || lines.length <= height) return lines;
    const headerCount = Math.min(5, lines.length);
    const footerCount = Math.min(4, Math.max(0, lines.length - headerCount));
    const body = lines.slice(headerCount, Math.max(headerCount, lines.length - footerCount));
    const maxOffset = Math.max(0, body.length - 1);
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxOffset);
    const indicatorCount = (this.scrollOffset > 0 ? 1 : 0) + (this.scrollOffset < maxOffset ? 1 : 0);
    const bodyHeight = Math.max(1, Math.min(body.length, height - headerCount - footerCount - indicatorCount));
    const start = Math.min(this.scrollOffset, Math.max(0, body.length - bodyHeight));
    const end = Math.min(body.length, start + bodyHeight);
    const result = [
      ...lines.slice(0, headerCount),
      ...(start > 0 ? [this.theme.fg("dim", "↑ content above")] : []),
      ...body.slice(start, end),
      ...(end < body.length ? [this.theme.fg("dim", "↓ content below")] : []),
      ...lines.slice(Math.max(headerCount, lines.length - footerCount)),
    ];
    return result.slice(0, height);
  }

  private selection(stageId: string): Set<string> {
    let selected = this.selections.get(stageId);
    if (!selected) {
      selected = new Set();
      this.selections.set(stageId, selected);
    }
    return selected;
  }

  private renderRowsForReview(rows: readonly Row[], width: number): string[] {
    const lines: string[] = [];
    rows.forEach((row, index) => {
      const active = index === this.selectedIndex;
      const prefix = active ? this.theme.fg("accent", "> ") : "  ";
      lines.push(...wrapTextWithAnsi(`${prefix}${rowLabel(row)}`, Math.max(1, width)));
      if (rowDescription(row)) {
        for (const line of wrapTextWithAnsi(this.theme.fg("muted", `     ${rowDescription(row)}`), Math.max(1, width))) lines.push(line);
      }
    });
    return lines;
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
        for (const line of wrapTextWithAnsi(this.theme.fg("muted", `     ${rowDescription(row)}`), Math.max(1, width))) lines.push(line);
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
    const text = value.trim();
    if (this.inputMode === "note") {
      if (stage) this.setStageNote(stage.id, text);
      this.inputMode = "none";
      this.editor.setText("");
      this.editor.focused = false;
      this.invalidate();
      return;
    }
    if (this.inputMode === "globalNote") {
      this.globalNote = text;
      this.inputMode = "none";
      this.editor.setText("");
      this.editor.focused = false;
      this.invalidate();
      return;
    }
    if (!stage) return;
    if (this.inputMode === "revision") {
      if (!text) {
        this.inputMode = "none";
        this.editor.setText("");
        this.editor.focused = false;
        this.invalidate();
        return;
      }
      const revision: ReviewRevision = {
        stageId: stage.id,
        stageIndex: this.inputStageIndex,
        feedback: text,
        requestedRound: this.review.round + 1,
      };
      this.finish(resultFor(this.review, "revision", this.answers, this.skippedStageIds, revision, this.globalNote));
      return;
    }
    if (!text) {
      this.inputMode = "none";
      this.editor.setText("");
      this.editor.focused = false;
      this.invalidate();
      return;
    }
    this.storeAnswer(stage.id, makeCustomAnswer(stage, this.inputStageIndex, text));
    this.skippedStageIds.delete(stage.id);
    this.inputMode = "none";
    this.editor.setText("");
    this.editor.focused = false;
    this.advanceAfterAnswer();
  }

  private advanceAfterAnswer(): void {
    const missingStage = unresolvedStages(this.review, this.answers, [...this.skippedStageIds])[0];
    if (missingStage) {
      this.stageIndex = this.review.stages.indexOf(missingStage);
      this.selectedIndex = 0;
      this.invalidate();
      return;
    }
    this.stageIndex = this.review.stages.length;
    this.selectedIndex = rowsForReview().findIndex((row) => row.kind === "approve");
    this.invalidate();
  }

  private finish(result: ReviewResult): void {
    if (this.finished) return;
    this.finished = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.editor.setText("");
    this.editor.focused = false;
    this._focused = false;
    this.done(result);
  }
}

export async function runVisualReviewWizard(
  ctx: ExtensionContext,
  review: NormalizedReview,
  initialAnswers: readonly ReviewAnswer[] = [],
  initialSkippedStageIds: readonly string[] = [],
  initialGlobalNote = "",
): Promise<ReviewResult> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    const { makeFallbackResult } = await import("./fallback.ts");
    return makeFallbackResult(review, ctx.hasUI ? "no_custom_ui" : "no_ui");
  }
  let wizard: VisualReviewWizard | undefined;
  let overlayHandle: OverlayHandle | undefined;
  const removeTerminalListener = ctx.ui.onTerminalInput((data) => {
    if (!wizard || !overlayHandle || (!overlayHandle.isHidden() && !overlayHandle.isFocused())) return undefined;
    if (!wizard.handleTerminalInput(data)) return undefined;
    if (overlayHandle.isHidden()) ctx.ui.notify("Visual review hidden — press Ctrl+] to reopen", "info");
    return { consume: true };
  });
  try {
    return await ctx.ui.custom<ReviewResult>((tui, theme, keybindings, done) => {
      wizard = new VisualReviewWizard(
        tui,
        theme,
        review,
        ctx.cwd,
        done,
        initialAnswers,
        ctx.signal,
        initialSkippedStageIds,
        initialGlobalNote,
        keybindings,
        async (value) => {
          const command = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getExternalEditorCommand();
          if (!command) return ctx.ui.editor("Edit custom answer", value);
          return editWithExternalEditor(tui, command, value);
        },
      );
      return wizard;
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "100%",
        maxHeight: "100%",
        margin: { left: 0, right: 0, bottom: 0 },
      },
      onHandle: (handle) => {
        overlayHandle = handle;
        wizard?.setOverlayHandle(handle);
      },
    });
  } finally {
    removeTerminalListener();
  }
}

export { selectedOptions };
