import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { editWithExternalEditor } from "./external-editor.ts";
import {
  Editor,
  getCapabilities,
  getCellDimensions,
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
import { renderMockup, type MockupSpec } from "./mockup-renderer.ts";
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
/**
 * The panel's fixed geometry.
 *
 * `FURNITURE_ROWS` are the host's own lines at the bottom of the terminal - the
 * input line, its blank, the cwd/status line and a multiplexer bar - which a
 * review must not cover: you still have to be able to read the conversation and
 * see what you are typing into. `CHROME_ROWS` is the panel's own fixed header and
 * footer, and `MAX_ROWS` caps how much of a tall screen a question may take.
 */
/**
 * Is this rendered row one of the stage's answerable options?
 *
 * The answer shape depends on the stage: a single-select row is numbered
 * ("1. Transit airy"), a multi-select row carries a checkbox and no number
 * ("[ ] Transit airy"), and either may carry the cursor prefix. The band window
 * has to recognise all of them, and it has to agree with `renderRows` - an
 * earlier version recognised only the numbered shape, so on a multi-select stage
 * the window measured a list of zero options and quietly pushed the first ones
 * out of the frame, where the cursor could still land on them and answer with
 * a choice nobody had seen.
 */
function isChoiceRow(line: string): boolean {
  return /^\s*(?:>\s*)?(?:\d+\.\s+|\[[ x]\]\s+)\S/.test(line);
}

/** Does this stage carry anything for the content area - a picture, a change list or a mockup? */
function hasVisualContent(stage: NormalizedStage): boolean {
  return stage.options.some((option) => Boolean(option.image) || Boolean(option.mockup) || Boolean(option.changes?.length));
}

const PANEL_FURNITURE_ROWS = 5;
const PANEL_MAX_ROWS = 32;
const MIN_PANEL_ROWS = 14;
/** An option that carries a picture gets this many rows, even on a short screen. */
const MIN_ART_ROWS = 6;
const CHROME_ROWS = 6;

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

/**
 * The stage rows: the options, then the actions that are not answers.
 *
 * A note row is a real row rather than a hidden key. The reference dialog puts
 * its note affordance in the list, and a key nobody can see is a feature nobody
 * uses - but it is kept out of the numbered answer sequence, because it does not
 * answer anything.
 */
function rowsForStage(stage: NormalizedStage): Row[] {
  const rows: Row[] = stage.options.map((option) => ({ kind: "option", option }));
  if (stage.multiSelect) rows.push({ kind: "done" });
  rows.push({ kind: "note" });
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

/**
 * Terminate an iTerm2 inline-image sequence that the renderer left open.
 *
 * pi-tui emits `ESC ] 1337 ; File=...:<base64>` with **no** BEL or ST; the next
 * escape it writes (an SGR reset, a hyperlink) is what closes the string in
 * practice. A terminal that takes the protocol literally finds no end of image
 * there, and the picture never appears. Closing the sequence is the difference
 * between "maybe" and "drawn", and it costs one byte on a line nobody reads.
 */
export function terminateITerm2Images(line: string): string {
  // The payload is taken greedily and *then* checked, rather than with a
  // lookahead: a lookahead makes the engine backtrack to a shorter payload
  // whenever the run is followed by another escape, which truncates the image.
  return line.replace(/\u001b\]1337;File=[^:]*:([A-Za-z0-9+/=]*)/g, (match, _payload, offset, whole) => {
    const terminator = whole[offset + match.length];
    return terminator === "\u0007" || match.endsWith("\u001b\\") ? match : `${match}\u0007`;
  });
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "…");
}

/**
 * The iTerm2 inline image, encoded here rather than by pi-tui.
 *
 * pi-tui's iTerm2 encoder is broken in a way no caller can work around: it
 * declares `size=527315` and then writes **62 bytes** of PNG, with no BEL or
 * ST closing the sequence. Verified on the real frame - an iTerm2-style
 * terminal therefore never gets a picture from this package, whatever the
 * review looks like on every other terminal. The bytes are already in hand
 * (`LoadedImage.base64`), so the sequence is written correctly here: full
 * payload, explicit cell box, proper terminator.
 */
function iTerm2ImageLines(image: LoadedImage, width: number, maxHeight: number): string[] {
  const cell = getCellDimensions();
  const cells = Math.max(1, Math.min(width - 2, image.dimensions?.widthPx ?? width * cell.widthPx));
  const rows = Math.max(1, Math.min(maxHeight, Math.ceil((cells * cell.widthPx) / Math.max(1, cell.heightPx))));
  const payload = Buffer.from(image.base64, "base64");
  const sequence = `\u001b]1337;File=inline=1;size=${payload.length};width=${cells};height=${rows}:${image.base64}\u0007`;
  // The TUI reserves the rows the picture occupies, the same way the Kitty path
  // does: blank lines above, the sequence on the last one.
  const blank = Array.from({ length: Math.max(0, rows - 1) }, () => "");
  return [...blank, sequence];
}

function imageLines(image: LoadedImage, theme: Theme, width: number, maxHeight = 16): string[] {
  if (getCapabilities().images === "iterm2") return iTerm2ImageLines(image, Math.max(1, width), maxHeight);
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
  const lines = component.render(Math.max(1, width));
  // A result with no graphics escape in it is pi-tui's *text* fallback - a
  // bracketed "[Image: path ...]" line - which tells the user nothing and
  // spends a content area doing it. Hand the decision back so the caller can
  // say why, and say what to do.
  return lines.some(isImageLine) ? lines : [];
}

/** A markdown preview carried by the option itself, rendered the way pi-tui renders it. */
function markdownPreview(option: NormalizedOption, theme: Theme, width: number): string[] {
  const markdown = new Markdown(option.preview!, 1, 0, markdownTheme(theme), undefined, { renderLatex: false });
  return [...markdown.render(width)];
}

/** Readable text fallback used when inline images are unavailable, loading, or failed. */
function fallbackPreview(option: NormalizedOption, loaded: LoadedOption | undefined, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  const source = option.image?.path ?? option.image?.url;
  if (source) {
    const label = loaded?.error ? `Image unavailable: ${loaded.error}` : `Image: ${imageFileLink(source)}`;
    lines.push(...wrapTextWithAnsi(theme.fg("muted", label), width));
    // A terminal that cannot draw an inline image is a property of the host, not
    // of the option. Saying so - with the switch that fixes it - is the
    // difference between "why is there no picture?" and an answer.
    if (!canRenderImages()) {
      // Name what was detected and the switch that overrides it. Naming tmux
      // alone was wrong the moment the host is something else that pi-tui
      // declines to trust, and a wrong cause sends the reader to fix the wrong
      // thing.
      const detected = getCapabilities().images ?? "none";
      // Measured on tmux 3.6a with a hand-made sequence: the raw escape arrives
      // at the terminal with its introducer's ESC stripped, and the passthrough
      // envelope is not forwarded at all. So a multiplexer is not a detour here,
      // it is a wall, and the advice has to be "run outside it".
      const cause = process.env.TMUX
        ? "a multiplexer is in the way: measured here, tmux 3.6a delivers no usable graphics introducer, by the direct route or by passthrough"
        : "this terminal did not report an image protocol";
      lines.push(...wrapTextWithAnsi(theme.fg("dim", `Inline images are off here: detected ${detected}, and ${cause}. Run Pi outside tmux for pictures; PI_IMAGE_PROTOCOL=kitty overrides the detection where that is enough.`), width));
    }
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

/**
 * The visible text of a rendered line, escape sequences removed.
 *
 * The short-screen trim decides which footer lines it can afford to drop by
 * reading them, and a line wrapped in colour still has to be recognisable.
 */
function stripPlain(line: string): string {
  return line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
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
  /** Whether this review asked for its option images to be drawn at all. */
  private readonly imagesEnabled: boolean;
  /**
   * Row density, seeded from the review and toggleable with Ctrl+D.
   *
   * Comfortable is today's behaviour: a reason under every choice. Compact lists
   * the choices alone and moves the highlighted one's reason into the content
   * area, which roughly doubles how many options fit in the same fixed block.
   */
  private density: "comfortable" | "compact";
  /** True when this frame dropped the reasons under the choices to make room. */
  private reasonsDropped = false;
  /** Whether the frame being built prints a reason under every choice. */
  private reasonsShown = false;
  /** How many options the band scrolled out of view, above and below. */
  private bandWindow: { above: number; below: number } | null = null;
  private collapsed = false;
  private _focused = false;
  private stageIndex = 0;
  private selectedIndex = 0;
  private inputMode: "none" | "other" | "revision" | "note" | "globalNote" = "none";
  private inputStageIndex = 0;
  private globalNote = "";
  /** A clamped stage prompt opens short; ctrl+r reads the rest. */
  private promptExpanded = false;
  /** Set once the option list has reached its action rows, so the rule prints once. */
  private actionRule = false;
  /** Pre-select the recommended option. Off unless the review asks for it or the user toggles it. */
  private autoResolve: boolean;
  /** The stage the recommendation was last applied to, so navigation is never fought. */
  private autoStage: string | null = null;
  /** Whether the prompt on screen is the clamped form, so the footer can offer ctrl+r. */
  private promptClamped = false;
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
    this.autoResolve = review.autoResolve === true;
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

    // Images are decoration and the structure is the decision, so a review
    // draws pictures only when it asks for them. `images: "on"` is how the
    // benchmark and the live smoke still get a picture to look at.
    this.imagesEnabled = review.images === "on";
    this.density = review.density;
    this.imageMode = this.imagesEnabled && canRenderImages() && review.stages.some((stage) => stage.options.some((option) => option.image));
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
    // Ctrl+A turns auto-resolve on and off. It is a view toggle over the list,
    // so it is inert while the editor has focus - where Ctrl+A is the editor's
    // own "jump to line start" and must stay that.
    // Ctrl+D toggles density: a view choice over the list, so it is inert while
    // the editor has focus, where Ctrl+A is the editor's own "jump to line start".
    if (this.inputMode === "none" && matchesKey(data, Key.ctrl("d"))) {
      this.density = this.density === "comfortable" ? "compact" : "comfortable";
      this.invalidate();
      return;
    }
    if (this.inputMode === "none" && matchesKey(data, Key.ctrl("a"))) {
      this.autoResolve = !this.autoResolve;
      this.autoStage = null;
      this.invalidate();
      return;
    }
    // Ctrl+R reads a clamped stage prompt in full. It is a view toggle, so it
    // never reaches the editor, and it is inert once the prompt already fits.
    if (matchesKey(data, Key.ctrl("r")) && this.currentStage()) {
      this.promptExpanded = !this.promptExpanded;
      this.invalidate();
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
      // The whole point of hiding it: the conversation underneath is what the
      // user needs to read, so the hidden form is one dim line and nothing else.
      return [this.theme.fg("dim", `Review hidden — Ctrl+] brings it back · ${this.answerCount()} answered · answers kept`)];
    }
    const terminalRows = this.tui.terminal?.rows;
    if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === (terminalRows ?? -1)) return this.cachedLines;
    const safeWidth = Math.max(20, width);
    const stage = this.currentStage();
    const lines: string[] = [];
    const border = (text: string) => this.theme.fg("borderAccent", text);
    const addWrapped = (text: string, indent = 1): string[] => {
      const wrapped = wrapTextWithAnsi(text, Math.max(1, safeWidth - indent));
      const added = wrapped.map((line) => `${" ".repeat(indent)}${line}`);
      lines.push(...added);
      return added;
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
    // The layout is decided before anything is drawn, because in the stacked
    // layout the question belongs in the footer with the options - printing it
    // at the top as well is how it ended up on screen twice.
    //
    // The footer and the tail are rendered *first* so the artwork gets exactly
    // the rows that are left. Budgeting the artwork from a guessed chrome
    // constant is what clipped the last action row off the bottom: the terminal
    // is the only thing that knows how tall the frame is allowed to be.
    const rows = this.currentRows();
    // Set once the stacked layout has emitted the footer, the tail and the
    // closing rule itself, so the shared blocks below stand down.
    let emitted = false;
    // The stacked layout is a dialogue menu: the artwork is the scene, the
    // question and the highlighted option's own sentence sit over it, and the
    // choices are one line each along the bottom. Descriptions under every row
    // made the list twice as tall as it needed to be and pushed the picture
    // up; here the information follows the cursor, which is what the reader is
    // actually looking at.
    // A stage has content to put in the content area when any option carries an
    // image, a mockup, a preview, or its own change list. A change list counts:
    // it is the model's way of saying what the option would change, and it is
    // the reason the block is the size it is.
    const visualStage = Boolean(stage && stage.options.some((option) => option.image || option.mockup || option.preview?.trim() || (option.changes && option.changes.length > 0)));
    const footerLines: string[] = [];
    if (stage && safeWidth >= 60 && (this.imageMode || visualStage)) {
      // A seam. Without one the picture, the sentence and the question read as
      // one undifferentiated run, and a block that is 32 rows of mixed content
      // is much harder to scan than three labelled bands.
      const seam = () => this.theme.fg("borderAccent", "─".repeat(Math.max(1, safeWidth - 2)));
      // Information first, then the question, then the choices: the bottom of
      // the screen is the decision, and what you are deciding about sits above
      // it. The question reading the way it does - a line under the scene, over
      // the menu - is the shape a dialogue menu has.
      // Compact lists the choices alone, so the highlighted option's reason goes
      // into the content area (see the detail block below) where there is room
      // for the whole sentence; in comfortable it already sits under its own
      // row. Exactly one place, whichever mode we are in.

      footerLines.push(seam());
      const question = stage.prompt.replace(/\s+/g, " ").trim();
      footerLines.push(this.theme.fg("accent", ` ${truncateToWidth(question, safeWidth - 2)}`));
      footerLines.push("");
      // The choices get their own band, and the actions below them get a third.
      // Comfortable spells the reason under every choice; compact lists the
      // choices alone, and the highlighted one's reason is rendered in the
      // content area instead, where there is room for the whole sentence.
      const showReasons = this.density === "comfortable";
      const choices = this.renderRows(stage, rows, safeWidth - 2, { describe: showReasons }).map((line) => ` ${line}`);
      const firstAction = choices.findIndex((line) => /^\s+(?![>\s]*\d+\.)/.test(line));
      if (firstAction > 0) {
        footerLines.push(...choices.slice(0, firstAction), seam(), ...choices.slice(firstAction));
      } else {
        footerLines.push(...choices);
      }
    }
    const tailLines = this.tailLines(stage, safeWidth);
    // The stacked layout only exists when there is artwork to stack *and* rows
    // to spare for it. Testing the budget alone is true for a text-only review
    // too, and that silently dropped every option row.
    // The layout is about where the content sits, not about whether it happens to
    // be a photograph: a mockup or a markdown preview is content too, and a stage
    // that carries one puts it on top with the questions under it, the same as an
    // image. Keying this on images alone is what put a review's preview *below*
    // its own questions.
    // Two footers, and the screen picks: the full one carries the highlighted
    // option's sentence, the essential one is the question and the choices. A
    // short screen gets the essential one rather than the old side-by-side
    // layout, which is the arrangement this layout exists to replace.
    const essentialFooter = stage && safeWidth >= 60
      ? [
        this.theme.fg("accent", ` ${truncateToWidth(stage.prompt.replace(/\s+/g, " ").trim(), safeWidth - 2)}`),
        // The essential band is the choices *without* a reason under each one.
        // That is what makes it shorter than the full one, and it is the shape
        // compact uses anyway - so a long comfortable review degrades into the
        // compact shape rather than losing its controls or outgrowing the panel.
        ...this.renderRows(stage, rows, safeWidth - 2, { describe: false }).map((line) => ` ${line}`),
      ]
      : [];
    // The panel is a fixed block and a hard bound: a review never grows past it.
    // What it contains is decided by the single rule below.
    const room = (footer: string[], tail: string[]) => this.panelRows(footer.length + tail.length + CHROME_ROWS);
    // One rule, in the order a reviewer needs things:
    //
    //   1. the picture keeps at least MIN_ART_ROWS rows, because a treatment
    //      drawn as a two-cell sliver is not a treatment;
    //   2. the optional furniture goes - the highlighted reason above the
    //      question, an alt line - so the picture can have those rows;
    //   3. the choice band drops the reasons under each choice, becoming the
    //      reason-free shape compact already uses;
    //   4. and if the choices still crowd the picture, the band becomes a
    //      *window*: the options that do not fit scroll, marked `↑ n more` and
    //      `↓ n more`. No option is ever dropped - a review that can be answered
    //      with a choice nobody saw is not a dense review, it is a wrong one.
    //
    // The band and the artwork budget are decided *together* and in this order,
    // because sizing the picture from a band that is about to shrink is what
    // collapsed it to a sliver while the rows it freed became blank padding.
    if (footerLines.length > 0 && room(footerLines, tailLines) < MIN_ART_ROWS) {
      const optional = footerLines.findIndex((line) => /This option|Alt:|Image:/.test(stripPlain(line)));
      while (optional >= 0 && room(footerLines, tailLines) < MIN_ART_ROWS) {
        footerLines.splice(optional, 1);
        if (footerLines.length === 0) break;
      }
    }
    this.reasonsDropped = false;
    if (footerLines.length > essentialFooter.length && room(footerLines, tailLines) < MIN_ART_ROWS) {
      footerLines.length = 0;
      footerLines.push(...essentialFooter);
      this.reasonsDropped = true;
    }
    // A long list does not lose choices, it scrolls. The band is a *window* onto
    // every option the model sent: the rows that do not fit are moved out of the
    // window rather than out of existence, the selected option is always inside
    // it, and the edges say how many are above and below.
    //
    // The earlier version spliced whole choices out of the band instead, and the
    // consequence was worse than a long list: pressing ↓ past the tenth row moved
    // the cursor onto an option that was never drawn and never marked, and Enter
    // recorded it. A review that can be answered with a choice the person never
    // saw is not a dense review, it is a wrong one.
    // The band is sized to what is left for the picture, in whole choice rows:
    // the band is a window onto every option, the window is as tall as the
    // picture can afford, and the options outside it are a scroll away rather
    // than gone.
    // The picture's floor outranks the list's length. A band too tall for the
    // panel does not get to shrink the picture to a sliver - it becomes a window
    // that scrolls, so every option stays reachable *and* the treatment stays
    // something a person can judge. `room` is what is left for the artwork if the
    // band stays as long as it is, and the window engages when that falls under
    // the picture's floor.
    //
    // The visible-row count is `windowBand`'s, and it is per *content type*: a
    // stage carrying a picture, a preview or a change list renders different rows,
    // and a multi-select row is a checkbox rather than a number, so
    // `isChoiceRow` has to recognise every shape that is really drawn.
    const crowded = room(footerLines, tailLines) < MIN_ART_ROWS;
    // The band handed to `windowBand` is rebuilt from the rows on every render,
    // so it already carries the marker the renderer just drew on the row the
    // cursor is on. That marker is the cursor's position in the window, and it is
    // what the window is anchored on. `selectedIndex` cannot be used for this:
    // it indexes the rows, and the identity of those rows says nothing about
    // which one the person is looking at.
    const bandWindow = stage && hasVisualContent(stage) && footerLines.length > 0 && crowded
      ? this.windowBand(footerLines, MIN_ART_ROWS - room(footerLines, tailLines))
      : null;
    // Stacked or side-by-side is decided on the *degraded* band: the band gives
    // up its reasons before the layout gives up the picture or the frame.
    // Stacked is the layout for a stage that has content. The artwork is sized
    // by the rows that are left, and a band that has degraded to the essential
    // one is the only thing that can push it to zero - so the only case that
    // falls back to side-by-side is a stage with content and no room at all even
    // for that, which the frame trim below then keeps inside the panel anyway.
    const stacked = footerLines.length > 0;
    // The picture takes the rows the *windowed* band leaves, so a long list
    // spends its slack on the artwork rather than on blank rows above a sliver.
    const imageBudget = stacked
      ? Math.max(bandWindow ? MIN_ART_ROWS : 0, room(footerLines, tailLines))
      : 0;
    // Whether the frame actually prints a reason under each choice, which is
    // what the density line reports.
    this.reasonsShown = this.density === "comfortable" && !this.reasonsDropped && stacked;
    this.bandWindow = bandWindow;

    if (stage) {
      // In the stacked layout the question is already in the footer, so the
      // top block is skipped entirely rather than falling through to the review
      // list, which is what a bare `stage && !stacked` guard did.
      if (stacked) {
        // nothing here: the footer owns the question.
      } else {
      // A prompt can be a paragraph. The reference dialog shows the question
      // and gets out of the way; a full page of model prose pushed the options
      // off the screen, so it is clamped to a few lines with the rest one
      // keypress away.
      const promptLines = wrapTextWithAnsi(stage.prompt, Math.max(1, safeWidth - 1)).map((line) => ` ${line}`);
      const limit = 3;
      if (this.promptExpanded) {
        lines.push(...promptLines);
      } else {
        lines.push(...promptLines.slice(0, limit));
        this.promptClamped = promptLines.length > limit;
        if (this.promptClamped) {
          lines.push(this.theme.fg("dim", `  … ${promptLines.length - limit} more lines — press ctrl+r to read the whole prompt`));
        }
      }
      if (stage.description) {
        lines.push("");
        addWrapped(this.theme.fg("muted", stage.description));
      }
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
      const sideBySide = Boolean(this.imageMode && stage && safeWidth >= 88);
      const leftWidth = sideBySide ? Math.min(44, Math.max(30, Math.floor(safeWidth * 0.34))) : safeWidth - 2;
      // Beside an image the column is too narrow for wrapped descriptions, so
      // the selected option's own sentence is rendered with its preview instead.
      const listLines = stage
        ? this.renderRows(stage, rows, leftWidth, { describe: !sideBySide && this.density === "comfortable" })
        : this.renderRowsForReview(rows, leftWidth);
      // The panel is the screen, so the thing being judged gets the screen: the
      // artwork sits above and the action sits under it in a fat footer. A
      // 32 x 16 cell box in the corner of a 110-column dialog made the artefact
      // the smallest thing on the page.
      if (stacked) {
        const selected = rows[this.selectedIndex];
        const option = selected?.kind === "option" ? selected.option : undefined;
        // The detail area, whatever is in it: the picture when it is there, the
        // reason when it is not. Either way it is padded to the panel's fixed
        // height, so the frame does not resize the moment a picture finishes
        // loading - a layout that jumps under the cursor is worse than one that
        // is a little empty.
        const detail: string[] = [];
        if (option) {
          const loaded = this.loadedImages.get(`${stage!.id}:${option.id}`);
          // What fills the content area, in priority order: the picture (when the
          // review asked for one and the host can draw it), the option's own
          // change list, the option's drawn mockup, and the option's description
          // - which in compact is the reason the list itself does not carry.
          const art = this.imagesEnabled && loaded?.image
            ? imageLines(loaded.image, this.theme, safeWidth - 2, imageBudget)
            : [];
          if (art.length > 0) detail.push(...art.map((line) => (isImageLine(line) ? line : ` ${line}`)));
          if (option.changes && option.changes.length > 0) {
            if (art.length > 0) detail.push("");
            detail.push(this.theme.fg("accent", ` This option changes:`));
            for (const line of option.changes) {
              for (const wrapped of wrapTextWithAnsi(this.theme.fg("text", `  • ${line}`), Math.max(1, safeWidth - 4))) detail.push(wrapped);
            }
            if (option.description && detail[detail.length - 1] !== "") detail.push("");
          } else if (option.mockup) {
            const mockup = this.mockupLines(option.mockup, safeWidth - 2, imageBudget);
            if (mockup && mockup.length > 0) {
              if (art.length > 0) detail.push("");
              detail.push(...mockup);
            }
          }
          // Priority, restored: picture, the change list, the mockup, and the
          // description. In compact the description is the reason the list does
          // not carry, so it is what a reviewer most needs to read there.
          if (option.description && (this.density === "compact" || (!art.length && !(option.changes && option.changes.length) && !option.mockup))) {
            if (detail.length > 0) detail.push("");
            for (const line of wrapTextWithAnsi(this.theme.fg("muted", option.description), Math.max(1, safeWidth - 4))) {
              detail.push(`  ${line}`);
            }
          }
          if (!art.length && !(option.changes && option.changes.length) && !option.mockup
            && !(this.density === "compact" && option.description)) {
            // Nothing to show in the content area; say so honestly rather than
            // padding with whitespace. The picture is off by default and a
            // mockup is an explicit opt-in.
            if (loaded?.error) {
              // A file that is not there is not a host that cannot draw. Saying
              // "tmux strips the introducer" for a bad path sends the reader to
              // fix the wrong thing.
              for (const line of wrapTextWithAnsi(this.theme.fg("error", `Image unavailable: ${loaded.error}`), Math.max(1, safeWidth - 4))) detail.push(`  ${line}`);
            } else if (this.imagesEnabled && option.image) {
              const reference = option.image.path ?? option.image.url ?? "image";
              const name = String(reference).split("/").pop() ?? String(reference);
              for (const line of wrapTextWithAnsi(
                this.theme.fg("dim", `Image: ${name} — pictures are off for this host (tmux 3.6a strips the introducer; run Pi outside tmux).`),
                Math.max(1, safeWidth - 4),
              )) detail.push(`  ${line}`);
              if (option.image.alt) {
                for (const line of wrapTextWithAnsi(this.theme.fg("muted", `Alt: ${option.image.alt}`), Math.max(1, safeWidth - 4))) detail.push(`  ${line}`);
              }
            }
          }
        }
        // The panel is a fixed block and a hard bound. The order of sacrifice,
        // once, in the order a reviewer needs things:
        //
        //   1. the artwork's own padding - it is the elastic part of the frame;
        //   2. the current answer, the note and the selected-items line, which
        //      echo what the review already shows;
        //   3. never the key hints, the auto-resolve mode or the density mode:
        //      those are how the person knows which mode they are in and what
        //      the keys do, and a review that hides its own controls is a review
        //      nobody can drive.
        const panelTotal = this.panelHeight();
        const overhead = () => lines.length + detail.length + footerLines.length + tailLines.length;
        const droppable: ((line: string) => boolean)[] = [
          (line) => /Selected:/.test(line),
          (line) => /Current answer:|Note:/.test(line),
          (line) => line === "",
        ];
        let guard = 0;
        while (overhead() > panelTotal && guard < 24) {
          guard += 1;
          // Only the detail's blank padding, never an escape: the Kitty escape is
          // the artwork's first line and the iTerm2 escape its last, so cutting
          // by position would delete the picture itself.
          let removed = false;
          for (let index = detail.length - 1; index >= 0; index -= 1) {
            if (/^\s*$/.test(detail[index] ?? "")) {
              detail.splice(index, 1);
              removed = true;
              break;
            }
          }
          if (!removed) {
            // The detail is down to its last non-blank, which for a picture means
            // the escape itself. What is left to give is the footer's echo, and
            // only up to the key hints: the controls and the frame's height
            // outrank the rows that repeat what the review already shows.
            const hintAt = tailLines.findIndex((line) => /↑↓ move/.test(stripPlain(line)));
            const droppableNow = droppable.find((isDroppable) => tailLines.some(isDroppable));
            const lastEcho = droppableNow ? tailLines.findIndex(droppableNow) : -1;
            if (hintAt > 0 && lastEcho >= 0 && lastEcho < hintAt) {
              tailLines.splice(lastEcho, 1);
              continue;
            }
            if (footerLines.length > essentialFooter.length) {
              footerLines.length = 0;
              footerLines.push(...essentialFooter);
              continue;
            }
            break;
          }
        }
        // Whatever slack is left goes above the content, so the picture, the
        // information and the answers read as one solid run down to the bottom.
        if (panelTotal > overhead()) {
          detail.unshift(...Array.from({ length: panelTotal - overhead() }, () => ""));
        }
        const stackedFrame = [...detail, ...footerLines, ...tailLines];
        // The panel is a hard bound, and a band longer than the panel is the one
        // case nothing can give rows: the choices are the review. So the frame is
        // clipped from the top - never the footer, which is the controls - and
        // the scroll indicator tells the reader there is more above.
        // `CHROME_ROWS` is the header, the blank above the tabs and the closing
        // rule - and `lines` already holds the header rows, so the two must not
        // be subtracted twice. The artwork is padded to fill whatever the band
        // and the controls leave, so this bound only bites when the band alone is
        // longer than the panel, which is the one case nothing can give rows.
        const headroom = Math.max(0, panelTotal - tailLines.length);
        if (stackedFrame.length > headroom) {
          // A band longer than the panel is the one case where nothing can give
          // rows, because the choices are the review. So the frame is cut from
          // the top - and never into the artwork: the Kitty escape is its first
          // line and the iTerm2 escape its last, so the picture is kept whole
          // and the rows above it go first.
          const excess = stackedFrame.length - headroom;
          const artIndex = stackedFrame.findIndex(isImageLine);
          // Never cut into the artwork (its first line for Kitty, its last for
          // iTerm2) and never cut away the row the cursor is on: a frame with
          // no visible cursor is a frame where Enter can answer with a choice
          // the person was never shown.
          let cut = artIndex < 0 ? excess : Math.min(excess, artIndex);
          const markedAt = stackedFrame.findIndex((line) => /^\s*>\s/.test(stripPlain(line)));
          if (markedAt >= 0 && markedAt < cut) cut = markedAt;
          lines.push(...stackedFrame.slice(cut));
        } else {
          lines.push(...stackedFrame);
        }
        emitted = true;
      } else if (sideBySide) {
        const rightWidth = Math.max(1, safeWidth - leftWidth - 5);
        const left = new LinesComponent(listLines);
        const selected = rows[this.selectedIndex];
        const rightLines = selected?.kind === "option" && stage ? this.renderSelectedVisual(selected.option, rightWidth) : [
          this.theme.fg("dim", "Select an option to see its preview."),
          "",
          ...(stage?.options.slice(0, 3).flatMap((option) => [`${option.label}: ${option.description ?? ""}`]) ?? []),
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
        // Compact lists the choices alone, so the highlighted option's reason
        // leads the list. The question is chrome and stays above it; the reason
        // belongs with the choices it explains, not with the question.
        const plainSelected = rows[this.selectedIndex];
        if (this.density === "compact" && plainSelected?.kind === "option" && plainSelected.option.description) {
          for (const line of wrapTextWithAnsi(this.theme.fg("muted", plainSelected.option.description), safeWidth - 4)) {
            lines.push(`  ${line}`);
          }
          lines.push("");
        }
        for (const line of listLines) lines.push(` ${line}`);
        const selected = rows[this.selectedIndex];
        if (selected?.kind === "option" && stage) {
          // In the text layout the option's description is already spelled out
          // under its row, so a preview block that would only repeat it is
          // dropped. An image or a markdown preview is new information and stays.
          const option = selected.option;
          const worthABlock = Boolean(option.image) || Boolean(option.preview?.trim());
          if (worthABlock) {
            lines.push("");
            for (const line of this.renderSelectedVisual(option, safeWidth - 4)) {
              if (isImageLine(line)) lines.push(line);
              else lines.push(`  ${line}`);
            }
          }
        }
      }
      if (emitted) {
        // The stacked layout already laid out the footer, the current answer,
        // the key hints and the closing border.
      } else {
        // tailLines owns the current answer, the note, the key hints, the
        // auto-resolve line and the density line, so no layout can lose one.
        lines.push(...this.tailLines(stage, safeWidth));
      }
    }

    if (!emitted) {
      // tailLines already closed the block with its rule.
    }
    const bounded = lines.map((line) => isImageLine(line) ? line : fitLine(line, safeWidth));
    const visible = this.visibleLines(bounded.map((line) => terminateITerm2Images(line)));
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

  /**
   * How many trailing rows are the panel's own, and must never be scrolled away.
   *
   * It used to be a fixed four, which was true when the tail was four rows: a
   * blank, the key hints, the auto-resolve line and the closing rule. The tail
   * grew - a current answer, a note, a selected-items line, the density mode -
   * and a fixed window started clipping the modes off the bottom of a long
   * review, which is how a default review with ten options lost its own
   * controls. The window is now the tail itself, so everything the panel pins
   * stays pinned and the body is what scrolls.
   */
  private tailRows(): number {
    const stage = this.currentStage();
    const rows = ["", 1]; // the leading blank and the closing rule
    if (stage && this.answers.has(stage.id)) rows.push(1);
    if (stage && this.currentNote() && !(stage && this.answers.get(stage.id)?.notes)) rows.push(1);
    rows.push(1); // key hints
    rows.push(1); // auto-resolve
    rows.push(1); // density
    if (stage?.multiSelect && this.selection(stage.id).size > 0) rows.push(1);
    return rows.length;
  }

  private visibleLines(lines: string[]): string[] {
    const height = this.tui.terminal?.rows;
    if (!height || height <= 0 || lines.length <= height) return lines;
    const headerCount = Math.min(5, lines.length);
    const footerCount = Math.min(this.tailRows(), Math.max(0, lines.length - headerCount));
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

  private answerCount(): number {
    return this.review.stages.filter((stage) => this.answers.has(stage.id)).length;
  }

  /**
   * Land on the recommended option when auto-resolve is on.
   *
   * It only *moves the cursor* - the user still presses Enter - because a review
   * that answers itself is a review nobody read, and the ask is the whole point
   * of the tool. The recommended row is the one the model marked, or the first
   * option, and the row says which.
   */
  private applyAutoResolve(): void {
    if (!this.autoResolve) return;
    const stage = this.currentStage();
    if (!stage || this.autoStage === stage.id) return;
    this.autoStage = stage.id;
    const rows = this.currentRows();
    const recommended = rows.findIndex((row) => row.kind === "option" && row.option.recommended);
    const target = recommended >= 0 ? recommended : rows.findIndex((row) => row.kind === "option");
    if (target >= 0) this.selectedIndex = target;
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
      const description = row.kind === "globalNote" ? rowDescription(row) : undefined;
      if (description) {
        for (const line of wrapTextWithAnsi(this.theme.fg("muted", `     ${description}`), Math.max(1, width))) lines.push(line);
      }
    });
    return lines;
  }

  /**
   * The stage rows.
   *
   * Numbered like the reference dialog, one line per row, and the per-row
   * description is only spelled out when the list has the width for it: in the
   * side-by-side layout a 36-cell column turned every description into three
   * ragged lines, which is what made this look unfinished next to the
   * reference. Action rows say what they are in their label, so their
   * descriptions are not repeated underneath.
   */
  private renderRows(stage: NormalizedStage, rows: readonly Row[], width: number, { describe = true } = {}): string[] {
    this.applyAutoResolve();
    const lines: string[] = [];
    const selected = this.selection(stage.id);
    rows.forEach((row, index) => {
      const active = index === this.selectedIndex;
      const prefix = active ? this.theme.fg("accent", "> ") : "  ";
      // Answers and the actions that end or extend the review are not the same
      // kind of thing, and the reference dialog keeps them apart: a rule before
      // the action rows, and the actions themselves dimmed.
      const action = !["option", "done"].includes(row.kind);
      if (action && !this.actionRule) lines.push("");
      if (action) this.actionRule = true;
      // Checkboxes for a multi-select stage: the answer is a set, and a checkbox
      // says that before the user has read the row.
      const box = row.kind === "option" && stage.multiSelect ? (selected.has(row.option.id) ? "[x] " : "[ ] ") : "";
      const recommended = row.kind === "option" && row.option.recommended ? this.theme.fg("success", " (recommended)") : "";
      // Actions sit behind the rule and keep out of the answer numbering: they do
      // not answer anything, and "press 3" should never be one of them.
      const numbered = action || box ? "" : `${index + 1}. `;
      const label = `${box}${numbered}${rowLabel(row)}${recommended}`;
      const text = `${prefix}${label}`;
      lines.push(...(action && !active ? wrapTextWithAnsi(this.theme.fg("muted", text), Math.max(1, width)) : wrapTextWithAnsi(text, Math.max(1, width))));
      const description = row.kind === "option" || row.kind === "globalNote" ? rowDescription(row) : undefined;
      if (describe && description) {
        for (const line of wrapTextWithAnsi(this.theme.fg("muted", `     ${description}`), Math.max(1, width))) lines.push(line);
      }
    });
    return lines;
  }

  private renderSelectedVisual(option: NormalizedOption, width: number): string[] {
    const stage = this.review.stages[this.stageIndex];
    const key = `${stage.id}:${option.id}`;
    const loaded = this.loadedImages.get(key);
    const image = loaded?.image;
    const hasImage = this.imageMode && Boolean(image);
    const hasPreview = Boolean(option.preview?.trim());
    // An option that carries an image but sits on a terminal that cannot draw
    // it still has to say so - that is the case where the user is staring at a
    // file path wondering why there is no picture.
    const hasImageRef = Boolean(option.image?.path ?? option.image?.url ?? option.image?.dataUri);
    // Nothing to show at all is not a block worth three lines of "nothing to
    // see here": the option's own sentence is the preview, and if it has none
    // either, the pane stays empty rather than saying so at the user.
    if (!hasImage && !hasPreview && !hasImageRef && !option.description) return [];
    // The description belongs where the room is. In the side-by-side layout the
    // list is a narrow column, so the option's own sentence is spelled out with
    // its preview rather than wrapped three times beside it.
    const lines: string[] = [];
    if (hasImage || hasPreview || hasImageRef) lines.push(this.theme.fg("accent", `Preview: ${option.label}`));
    if (option.description) {
      if (lines.length) lines.push("");
      for (const line of wrapTextWithAnsi(this.theme.fg("muted", option.description), Math.max(1, width))) lines.push(line);
    }
    if (image && this.imageMode) {
      lines.push(...(lines.length ? [""] : []), ...imageLines(image, this.theme, width, this.previewRows()));
      return lines;
    }
    if (hasPreview) return [...lines, ...markdownPreview(option, this.theme, Math.max(1, width))];
    // An image this terminal cannot draw still deserves the path and the reason.
    if (hasImageRef) return [...lines, ...fallbackPreview(option, loaded, this.theme, Math.max(1, width))];
    // Text only: the option's own sentence is the whole preview, so the pane
    // does not also announce that there is nothing to show.
    return lines;
  }

  /**
   * How many rows the artwork may take above the action footer.
   *
   * The footer is sized first - one line for the question, one per row, one for
   * the current answer, two for the key hints - and whatever is left above it is
   * the picture. A negative result means the terminal is too short for the
   * stacked layout, and the caller falls back to the side-by-side one rather
   * than crushing both.
   */
  /**
   * How many rows the panel is, whatever the question contains.
   *
   * Fixed, because a panel that grows and shrinks with the content makes the
   * conversation jump every time the cursor moves between options, and a
   * full-screen one hides the input line. A big screen gets a big panel; a small
   * one keeps at least a usable dozen rows; either way the detail area is what
   * is left, and the answers stay pinned to the bottom of the panel.
   */
  private panelHeight(): number {
    const terminalRows = this.tui.terminal?.rows ?? 0;
    if (!Number.isFinite(terminalRows) || terminalRows <= 0) return 0;
    return Math.max(MIN_PANEL_ROWS, Math.min(terminalRows - PANEL_FURNITURE_ROWS, PANEL_MAX_ROWS));
  }

  private panelRows(footerHeight: number): number {
    const terminalRows = this.tui.terminal?.rows ?? 0;
    if (!Number.isFinite(terminalRows) || terminalRows <= 0) return 0;
    // Five rows of the host's own furniture: the input line, its blank, the
    // cwd/status line and the multiplexer bar.
    const usable = Math.max(MIN_PANEL_ROWS, Math.min(terminalRows - PANEL_FURNITURE_ROWS, PANEL_MAX_ROWS));
    return Math.max(0, usable - footerHeight);
  }

  /**
   * The part of the frame below the option list: the current answer, the note,
   * the key hints, the auto-resolve state and the closing border.
   *
   * It is rendered before the artwork so the artwork's budget is the remainder
   * of the terminal, not an estimate of it.
   */
  /**
   * A deterministic mockup, drawn at the size the content area actually has.
   *
   * `option.mockup` is the option's own content rendered by the package rather
   * than generated, and it was accepted by the schema and then never drawn: a
   * review built out of mockups showed its questions and nothing else. The
   * content area is exactly where it belongs, and it now fills it.
   */
  private mockupLines(spec: MockupSpec, width: number, height: number): string[] | null {
    const widthCells = Math.max(20, Math.min(80, width));
    const heightCells = Math.max(4, Math.min(30, height));
    try {
      const { png } = renderMockup(spec, { widthCells, heightCells });
      // Through the same image path as a photograph, so the drawable spec gets
      // the same chunking, the same cell box and the same passthrough handling.
      return imageLines({ base64: png.toString("base64"), mimeType: "image/png", source: "option.mockup", filename: "mockup.png" }, this.theme, widthCells, heightCells);
    } catch {
      // A spec the renderer cannot draw is not a reason to lose the question.
      return null;
    }
  }

  /**
   * Why there is no picture, in two lines instead of five.
   *
   * The full fallback prints the path as a markdown link *and* again as a
   * `file://` URL, then wraps the reason over three lines - in a panel whose
   * top half exists to hold a picture, that is a wall of path for nothing. The
   * name, the size and the reason are what a reader needs here; the full link
   * stays on the stage's own preview.
   */
  private compactFallback(option: NormalizedOption, loaded: LoadedOption | undefined, width: number): string[] {
    const lines: string[] = [];
    if (loaded?.error) {
      lines.push(...wrapTextWithAnsi(this.theme.fg("error", `Image unavailable: ${loaded.error}`), Math.max(1, width)));
      return lines;
    }
    const reference = option.image?.path ?? option.image?.url ?? option.image?.dataUri ?? "image";
    const name = reference.split("/").pop() ?? reference;
    lines.push(...wrapTextWithAnsi(this.theme.fg("muted", `Image: ${name}`), Math.max(1, width)));
    if (!canRenderImages()) {
      const cause = process.env.TMUX
        ? "a multiplexer is in the way: measured here, tmux 3.6a delivers no usable graphics introducer"
        : "this terminal did not report an image protocol";
      lines.push(...wrapTextWithAnsi(this.theme.fg("dim", `Inline images are off here (detected ${getCapabilities().images ?? "none"}): ${cause}. Run Pi outside tmux for pictures; PI_IMAGE_PROTOCOL=kitty overrides the detection where that is enough.`), Math.max(1, width)));
    }
    if (option.image?.alt) lines.push(...wrapTextWithAnsi(this.theme.fg("muted", `Alt: ${option.image.alt}`), Math.max(1, width)));
    return lines;
  }

  /**
   * The key hints, from one place.
   *
   * They used to be written out twice - once in the plain layout and once in the
   * stacked one - and the copies drifted, so a layout silently lost the density
   * shortcut. One method, every layout.
   */
  private keyHints(stage: NormalizedStage | undefined): string {
    if (!stage) return "↑↓ move • Enter review action • Tab stages • Ctrl+D density • Ctrl+] hide • Esc cancel";
    if (stage.multiSelect) return "↑↓ move • Space check • Enter confirm • n note • Tab stages • Ctrl+D density • Ctrl+] hide • Esc cancel";
    return `↑↓ move • Enter select • n note • Tab/←→ stages • Ctrl+D density • Ctrl+] hide • Esc cancel${this.promptClamped ? " • Ctrl+R prompt" : ""}`;
  }

  /**
   * What the density line says about *this* frame.
   *
   * Comfortable prints a reason under every choice until the list is long enough
   * that the reasons have to go so the picture and the controls can stay. A line
   * that keeps claiming otherwise is worse than no line: it is how a footer ends
   * up telling the reader to look for something that is not on screen.
   */
  private densityLine(): string {
    if (this.density === "compact") return "density: compact — one reason, in the panel above (Ctrl+D for comfortable)";
    return this.reasonsShown
      ? "density: comfortable — a reason under every choice (Ctrl+D for compact)"
      : "density: comfortable — reasons dropped to fit the list (Ctrl+D for compact)";
  }

  /**
   * Fit the band by scrolling it, never by deleting from it.
   *
   * The band is a window onto every option. When it is too tall for the picture
   * it shrinks, the selected row is scrolled into view, and the rows that fell
   * outside become a `↑ n more` / `↓ n more` marker so the person can see that
   * the list continues. `selectedIndex` indexes the *rows*, so the window is
   * computed from the marked row's position in the full band.
   */
  private windowBand(band: string[], growBy: number): { above: number; below: number } {
    if (growBy <= 0) return { above: 0, below: 0 };
    const choiceRows = band.map((line, index) => (isChoiceRow(line) ? index : -1)).filter((index) => index >= 0);
    if (choiceRows.length === 0) return { above: 0, below: 0 };
    // Options are not one row each: a single-select option carries its reason
    // beneath it and a multi-select one carries a checkbox, so the window is
    // measured in *rows* and cut only on option boundaries. Working in
    // option-counts and converting afterwards is what let the tail grow past the
    // budget and scroll the last option out of the frame.
    const first = choiceRows[0]!;
    const last = choiceRows[choiceRows.length - 1]!;
    const spanOf = (index: number): number => {
      const at = choiceRows[index]!;
      const next = index + 1 < choiceRows.length ? choiceRows[index + 1]! : last + 1;
      return next - at;
    };
    // The cursor is located by the marker the renderer already drew on this very
    // band, which was rebuilt for this render, so it names the row the person is
    // actually looking at. `selectedIndex` cannot stand in: it indexes rows, and
    // once the window has scrolled it points at a different option entirely, so
    // the window would fail to follow the cursor past its own start. When no row
    // carries the marker at all - an empty band, or a stage whose first row is
    // an action - the cursor stays where it was rather than jumping.
    const markedAt = choiceRows.findIndex((index) => /^\s*>\s/.test(band[index]!));
    const cursor = Math.max(0, Math.min(
      markedAt >= 0 ? markedAt : Math.min(this.selectedIndex, choiceRows.length - 1),
      choiceRows.length - 1,
    ));
    // The window always contains the cursor, and always fits the budget. Growing
    // greedily in one direction only is what left the cursor on a row that had
    // scrolled out of the window, with no marker anywhere on an option.
    const budgetRows = Math.max(1, (last - first + 1) - growBy);
    const fits = (from: number, to: number): boolean => {
      const top = choiceRows[from]!;
      const bottom = to < choiceRows.length ? choiceRows[to]! + (choiceRows[to + 1]! - choiceRows[to]!) - 1 : last;
      return bottom - top + 1 <= budgetRows;
    };
    let start = cursor;
    while (start > 0 && fits(start - 1, cursor)) start -= 1;
    let end = cursor + 1;
    while (end < choiceRows.length && fits(start, end)) end += 1;
    if (!fits(start, end - 1)) end = start + 1;
    const above = start;
    const below = choiceRows.length - end;
    const head = band.slice(0, first);
    const tail = band.slice(last + 1);
    const windowRows: string[] = [];
    if (above > 0) windowRows.push(this.theme.fg("dim", `   ↑ ${above} more`));
    windowRows.push(...band.slice(choiceRows[start]!, choiceRows[end - 1]! + 1));
    if (below > 0) windowRows.push(this.theme.fg("dim", `   ↓ ${below} more`));
    band.length = 0;
    band.push(...head, ...windowRows, ...tail);
    return { above, below };
  }

  private tailLines(stage: NormalizedStage | undefined, safeWidth: number): string[] {
    const out: string[] = [""];
    const current = stage ? this.answers.get(stage.id) : undefined;
    if (current) out.push(this.theme.fg("success", `Current answer: ${current.answer ?? current.optionLabels?.join(", ") ?? "(empty)"}${current.notes ? ` — ${current.notes}` : ""}`));
    const currentNote = stage ? this.currentNote() : undefined;
    if (currentNote && !current?.notes) out.push(this.theme.fg("muted", `Note: ${currentNote}`));
    const selection = stage ? this.selection(stage.id) : new Set<string>();
    out.push(this.theme.fg("dim", this.keyHints(stage)));
    out.push(this.theme.fg(this.autoResolve ? "success" : "dim", this.autoResolve
      ? "auto-resolve: on — Enter takes the recommended option (Ctrl+A off)"
      : "auto-resolve: off — Ctrl+A answers with the recommended option"));
    // Density is a mode, and it is stated in *every* layout: a switch that is
    // invisible in the layout that carries the picture is a switch nobody can find.
    // It reports what this frame is doing, not what the mode always does - a long
    // list drops the reasons to keep the picture, and the line says so rather
    // than claiming a reason under every choice that is not there.
    out.push(this.theme.fg(this.density === "compact" ? "success" : "dim", this.densityLine()));
    if (stage?.multiSelect && selection.size > 0) {
      out.push(this.theme.fg("accent", `Selected: ${stage.options.filter((option) => selection.has(option.id)).map((option) => option.label).join(", ")}`));
    }
    out.push("");
    out.push(this.theme.fg("borderAccent", "─".repeat(Math.max(1, safeWidth))));
    return out;
  }

  /**
   * How many rows the inline preview may take.
   *
   * This was a fixed 16, which drew a square image as a ~32 x 16 block inside a
   * pane nearly twice as wide: the art was legible and the screen was mostly
   * empty. The preview now grows with the terminal it is drawn in.
   */
  private previewRows(): number {
    const terminalRows = this.tui.terminal?.rows ?? 0;
    if (!Number.isFinite(terminalRows) || terminalRows <= 0) return 16;
    return Math.max(16, Math.min(28, Math.floor(terminalRows * 0.5)));
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
      // Full screen, not a bottom drawer. The questions are the work: a model
      // that sends a real prompt and real options needs rows for them, and a
      // half-height drawer both truncated the list and covered the conversation
      // the user needed to check the answer against. Ctrl+] still collapses the
      // whole thing to one line, which is the way back to the transcript.
      // Not a full-screen takeover. The review is a fixed-height block anchored
      // at the bottom of the conversation, so the transcript above it and the
      // input line, cwd/status line and multiplexer bar below it stay readable
      // while a question is open. The height is the frame's, and the frame is
      // the same size whatever the question contains.
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
