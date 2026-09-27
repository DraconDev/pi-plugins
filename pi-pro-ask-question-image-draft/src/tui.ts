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
 * Collapse a chunked Kitty escape into one escape.
 *
 * pi-tui transmits an image as many `\x1b_G<ctrl>;<chunk>\x1b\` escapes, one per
 * 4 KB. tmux's passthrough envelope ends at the *first* `ESC \` it sees, so a
 * chunked image is cut after its first chunk: the terminal receives a header
 * and 4 KB, and the rest of the picture is discarded. Concatenating the chunks
 * into a single escape carries the whole payload in one envelope - the escape
 * the terminal ends up parsing is the same image.
 */
export function collapseGraphicsChunks(sequence: string): string {
  if (!sequence.startsWith("\u001b_G")) return sequence;
  const chunks = [...sequence.matchAll(/\u001b_G([^;]*);([^\u001b]*)\u001b\\/g)];
  if (chunks.length <= 1) return sequence;
  const control = (chunks[0][1].split(",").filter((part) => !/^m=/.test(part))).join(",");
  const payload = chunks.map((chunk) => chunk[2]).join("");
  return `\u001b_G${control};${payload}\u001b\\`;
}

/**
 * Pass inline graphics through tmux.
 *
 * tmux does not forward an application's raw Kitty escape: it parses its own
 * terminal grammar, and an image escape is not in it. Measured on tmux 3.6a,
 * a frame carrying a 527,315-byte PNG reached the attached terminal with
 * **zero** of its 703,088 payload bytes. What tmux *does* forward is anything
 * wrapped in its passthrough envelope (`DCS tmux; <sequence> ST`), the same
 * envelope Ghostty uses for itself; the chunked escape is collapsed first,
 * because the envelope ends at the first `ESC \` inside it. With both, the
 * terminal receives the whole image, byte for byte.
 *
 * What that does *not* fix: a full-screen TUI under tmux. tmux repaints its own
 * grid and the terminal discards graphics tmux does not own, so a picture can
 * still be erased by the next repaint. Bytes arriving is necessary, not
 * sufficient - the configuration that reliably shows images is to run Pi
 * outside tmux (`env -u TMUX pi`), where the transmit and display escapes
 * reach the terminal directly. This wrapper is kept because it is the
 * difference between the payload being dropped and the terminal having it, and
 * it costs one string operation per line.
 */
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

export function passthroughGraphicsForHost(line: string, { tmux = Boolean(process.env.TMUX) } = {}): string {
  const closed = terminateITerm2Images(line);
  if (!tmux || !isImageLine(closed)) return closed;
  // A run of consecutive chunk escapes is one image and must become *one*
  // envelope: matching them one at a time wraps each chunk separately and
  // leaves a terminated escape in the middle of every envelope.
  // The data section is optional: pi-tui's display command (`a=d,d=I,i=<id>`)
  // carries no payload and still has to travel inside the envelope.
  const runs = /(?:\u001b_G[^;]*(?:;[^\u001b]*)?\u001b\\)+|\u001b\]1337;File=[^\x07\x1b]*(?:\x07|\u001b\\)/g;
  return closed.replace(runs, (sequence) => `\u001bPtmux;${collapseGraphicsChunks(sequence)}\u001b\\`);
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
  return component.render(Math.max(1, width));
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
      lines.push(...wrapTextWithAnsi(theme.fg("dim", "This terminal cannot draw inline images. Inside tmux that is the default: start Pi with PI_IMAGE_PROTOCOL=kitty and let tmux pass graphics through (allow-passthrough on, terminal-features Kitty)."), width));
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
    // Ctrl+A turns auto-resolve on and off. It is a view toggle over the list,
    // so it is inert while the editor has focus - where Ctrl+A is the editor's
    // own "jump to line start" and must stay that.
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
    const footerLines: string[] = [];
    if (this.imageMode && stage && safeWidth >= 60) {
      const question = stage.prompt.replace(/\s+/g, " ").trim();
      footerLines.push(this.theme.fg("accent", ` ${truncateToWidth(question, safeWidth - 2)}`));
      footerLines.push("");
      footerLines.push(...this.renderRows(stage, rows, safeWidth - 2, { describe: true }).map((line) => ` ${line}`));
    }
    const tailLines = this.tailLines(stage, safeWidth);
    // The stacked layout only exists when there is artwork to stack *and* rows
    // to spare for it. Testing the budget alone is true for a text-only review
    // too, and that silently dropped every option row.
    const stacked = footerLines.length > 0 && this.stageRows(lines.length + footerLines.length + tailLines.length) > 0;
    const imageBudget = stacked ? this.stageRows(lines.length + footerLines.length + tailLines.length) : 0;

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
      const listLines = stage ? this.renderRows(stage, rows, leftWidth, { describe: !sideBySide }) : this.renderRowsForReview(rows, leftWidth);
      // The panel is the screen, so the thing being judged gets the screen: the
      // artwork sits above and the action sits under it in a fat footer. A
      // 32 x 16 cell box in the corner of a 110-column dialog made the artefact
      // the smallest thing on the page.
      if (stacked) {
        const selected = rows[this.selectedIndex];
        const option = selected?.kind === "option" ? selected.option : undefined;
        if (option) {
          const key = `${stage!.id}:${option.id}`;
          const loaded = this.loadedImages.get(key);
          if (loaded?.image) {
            // pi-tui derives the row count from the image's aspect ratio and can
            // hand back one row more than the ceiling it was given. Trimming the
            // trailing blanks - never the escape on the first line - is what keeps
            // the frame exactly as tall as the terminal, so the last action row is
            // not clipped off the bottom.
            const art = imageLines(loaded.image, this.theme, safeWidth - 2, imageBudget);
            const frame: string[] = art.map((line) => (isImageLine(line) ? line : ` ${line}`));
            const artRows = frame.length;
            frame.push(...footerLines, ...tailLines);
            // The artwork is the only elastic part of the frame, so if pi-tui's
            // aspect arithmetic handed back more rows than the budget allowed,
            // the excess comes out of the artwork's padding and never out of the
            // options. Guessing the chrome instead is what clipped the last action
            // row off the bottom of a 40-row terminal.
            const terminalRows = this.tui.terminal?.rows ?? 0;
            const total = lines.length + frame.length;
            if (terminalRows > 0 && total > terminalRows) {
              const excess = Math.min(artRows, total - terminalRows);
              frame.splice(Math.max(0, artRows - excess), excess);
            }
            lines.push(...frame);
            emitted = true;
          } else {
            // No picture yet, or one this terminal cannot draw: the area says so
            // rather than collapsing to nothing.
            for (const line of fallbackPreview(option, loaded, this.theme, safeWidth - 4)) lines.push(`  ${line}`);
          }
        }
        // A stage whose selected row is not an option still gets its footer.
        if (!emitted) {
          lines.push(...footerLines, ...tailLines);
          emitted = true;
        }
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
      lines.push("");
      const current = stage ? this.answers.get(stage.id) : undefined;
      if (current) lines.push(this.theme.fg("success", `Current answer: ${current.answer ?? current.optionLabels?.join(", ") ?? "(empty)"}${current.notes ? ` — ${current.notes}` : ""}`));
      const currentNote = stage ? this.currentNote() : undefined;
      if (currentNote && !current?.notes) lines.push(this.theme.fg("muted", `Note: ${currentNote}`));
      const selection = stage ? this.selection(stage.id) : new Set<string>();
      const help = stage?.multiSelect
        ? `↑↓ move • Space check • Enter confirm • n note • Tab stages • Ctrl+] hide • Esc cancel`
        : stage
          ? `↑↓ move • Enter select • n note • Tab/←→ stages • Ctrl+] hide • Esc cancel${this.promptClamped ? " • Ctrl+R prompt" : ""}`
          : "↑↓ move • Enter review action • Tab stages • Ctrl+] hide • Esc cancel";
      lines.push(this.theme.fg("dim", help));
      // Auto-resolve is a mode, so it says so whether it is on or off. A switch
      // nobody can see is a switch nobody trusts.
      lines.push(this.theme.fg(this.autoResolve ? "success" : "dim", this.autoResolve
        ? "auto-resolve: on — Enter takes the recommended option (Ctrl+A off)"
        : "auto-resolve: off — Ctrl+A answers with the recommended option"));
      if (stage?.multiSelect && selection.size > 0) {
        lines.push(this.theme.fg("accent", `Selected: ${stage.options.filter((option) => selection.has(option.id)).map((option) => option.label).join(", ")}`));
      }
      }
    }

    if (!emitted) {
      lines.push("");
      lines.push(border("─".repeat(safeWidth)));
    }
    const bounded = lines.map((line) => isImageLine(line) ? line : fitLine(line, safeWidth));
    const visible = this.visibleLines(bounded.map((line) => passthroughGraphicsForHost(line)));
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
  private stageRows(alreadyRendered: number): number {
    const terminalRows = this.tui.terminal?.rows ?? 0;
    if (!Number.isFinite(terminalRows) || terminalRows <= 0) return 0;
    return Math.max(0, terminalRows - alreadyRendered);
  }

  /**
   * The part of the frame below the option list: the current answer, the note,
   * the key hints, the auto-resolve state and the closing border.
   *
   * It is rendered before the artwork so the artwork's budget is the remainder
   * of the terminal, not an estimate of it.
   */
  private tailLines(stage: NormalizedStage | undefined, safeWidth: number): string[] {
    const out: string[] = [""];
    const current = stage ? this.answers.get(stage.id) : undefined;
    if (current) out.push(this.theme.fg("success", `Current answer: ${current.answer ?? current.optionLabels?.join(", ") ?? "(empty)"}${current.notes ? ` — ${current.notes}` : ""}`));
    const currentNote = stage ? this.currentNote() : undefined;
    if (currentNote && !current?.notes) out.push(this.theme.fg("muted", `Note: ${currentNote}`));
    const selection = stage ? this.selection(stage.id) : new Set<string>();
    const help = stage?.multiSelect
      ? `↑↓ move • Space check • Enter confirm • n note • Tab stages • Ctrl+] hide • Esc cancel`
      : stage
        ? `↑↓ move • Enter select • n note • Tab/←→ stages • Ctrl+] hide • Esc cancel${this.promptClamped ? " • Ctrl+R prompt" : ""}`
        : "↑↓ move • Enter review action • Tab stages • Ctrl+] hide • Esc cancel";
    out.push(this.theme.fg("dim", help));
    out.push(this.theme.fg(this.autoResolve ? "success" : "dim", this.autoResolve
      ? "auto-resolve: on — Enter takes the recommended option (Ctrl+A off)"
      : "auto-resolve: off — Ctrl+A answers with the recommended option"));
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
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        margin: 0,
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
