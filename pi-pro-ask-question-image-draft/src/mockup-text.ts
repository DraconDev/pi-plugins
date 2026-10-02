/**
 * A mockup drawn with characters.
 *
 * The rasterised mockup is a PNG sent through the terminal's graphics protocol,
 * which means it disappears the moment the protocol does: tmux strips the
 * introducer, a plain ssh session has no protocol at all, and a pasted frame or
 * a log file carries nothing. That is the wrong failure for something that is
 * only ever labels, bars and chips on a cell grid - a drawing should need less
 * from a terminal than a photograph does, not more.
 *
 * So the same `MockupSpec` gets a second road. Where the protocol works the PNG
 * is used and this is never called; where it does not, this is what the reader
 * gets instead of a sentence explaining that pictures are off.
 *
 * The two are not trying to be pixel-identical. The raster is drawn on an 8x16
 * cell grid at 1:1 scale; this is drawn on the terminal's own cells with box
 * characters, so it is selectable, copyable and searchable - things a PNG in a
 * frame is none of.
 */

export interface MockupTextOptions {
  /** Columns available. The frame is drawn to fit, down to a legible minimum. */
  width: number;
  /** Rows available. Content beyond this is left out, never squashed. */
  height: number;
}

const FRAME_CHARS = {
  topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘",
  horizontal: "─", vertical: "│", teeDown: "┬", teeUp: "┴",
} as const;

/** Block characters for a bar, densest last. */
const BAR_FULL = "█";
const BAR_EMPTY = "░";

/**
 * How many terminal columns a string occupies.
 *
 * Counting code points is wrong for anything outside ASCII: a CJK ideograph is
 * two columns, so a label of thirty of them overflows a forty-column frame and
 * lands the right border in the middle of a character. Model-authored labels are
 * routinely CJK, so this is not hypothetical.
 */
const cells = (value: string): number => {
  let total = 0;
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0) ?? 0;
    // Wide ranges: CJK, Hangul, Kana, fullwidth forms, and the emoji blocks.
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1f9ff);
    total += wide ? 2 : 1;
  }
  return total;
};

const truncate = (value: string, width: number) => {
  const text = String(value ?? "");
  if (cells(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const character of text) {
    const size = cells(character);
    if (used + size > Math.max(0, width - 1)) break;
    out += character;
    used += size;
  }
  return `${out}…`;
};

const pad = (value: string, width: number) => {
  const text = truncate(value, width);
  return text + " ".repeat(Math.max(0, width - cells(text)));
};

/**
 * A horizontal bar of `cells` characters for a 0..1 value.
 *
 * Eight levels, because a bar made of half-blocks claims a precision a terminal
 * row does not have and reads as noise at small sizes.
 */
const bar = (value: number, cells: number) => {
  if (cells <= 0) return "";
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const filled = Math.round(clamped * cells);
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(Math.max(0, cells - filled));
};

/** The status word or chip beside a row, chosen the way the raster does. */
const statusMark = (status: string | undefined) => {
  if (status === "ok") return "ok";
  if (status === "warn") return "warn";
  if (status === "danger") return "late";
  if (status === "accent") return "new";
  return "";
};

/**
 * Draw the spec as text.
 *
 * `layout` changes the *arrangement* the way it does in the raster: a rail puts
 * a fixed column beside the content, a dense arrangement packs without the
 * gutters, and the rest are a single column with different spacing. What every
 * layout agrees on is that the title, the row count and the rows themselves are
 * always present, because those are what the reader is comparing.
 */
export function renderMockupText(spec: {
  layout?: string;
  title?: string;
  rows?: ReadonlyArray<{ label?: string; value?: number; status?: string; code?: string; detail?: string }>;
  headers?: readonly string[];
  emphasis?: string;
}, options: MockupTextOptions): string[] {
  // Geometry first, once: `outer` is the total width, `inner` is what fits
  // between the two verticals. Every row is padded to exactly `inner`, so the
  // right-hand edge is a straight line down the frame - the first version built
  // each row from pieces of different widths and the frame came out ragged.
  // `Math.min(72, NaN)` is NaN and `Math.max(28, NaN)` is NaN, so an unchecked
  // width made every `repeat()` below degenerate to an empty string and emitted
  // a six-cell frame instead of the documented minimum. Clamping a non-finite
  // input to the default is the difference between "smaller than asked" and
  // "not a frame at all".
  const safeWidth = Number.isFinite(options.width) ? options.width : 40;
  const safeHeight = Number.isFinite(options.height) ? options.height : 12;
  const outer = Math.max(28, Math.min(72, Math.floor(safeWidth)));
  const inner = outer - 4;
  const layout = spec.layout ?? "list";
  const rail = layout === "rail" || layout === "board" || layout === "overlay";
  const dense = layout === "dense" || layout === "tiles" || layout === "chart";

  // A title lives inside the top rule rather than being hung off it, because a
  // frame whose own border is broken is not a drawing of anything.
  const top = (title: string) => {
    const text = ` ${truncate(title, Math.max(1, inner - 2))} `;
    // corner + rule + text + fill + corner must be exactly `outer`, so the fill
    // is what is left after three of the five parts are spent.
    return `┌${FRAME_CHARS.horizontal}${text}${FRAME_CHARS.horizontal.repeat(Math.max(0, outer - 3 - cells(text)))}┐`;
  };
  // The rules are as wide as the rows they frame: a row is `│` + space + inner
  // + space + `│`, which is `outer` columns, so a rule needs `outer - 2`
  // horizontals between its corners. They used to repeat `inner` and came out
  // two cells short, so the right edge of every frame was a staircase.
  const rule = `├${FRAME_CHARS.horizontal.repeat(outer - 2)}┤`;
  const bottom = `└${FRAME_CHARS.horizontal.repeat(outer - 2)}┘`;
  const row = (text: string) => `${FRAME_CHARS.vertical} ${pad(text, inner)} ${FRAME_CHARS.vertical}`;

  const lines: string[] = [top(spec.title ?? "mockup")];
  const declared = spec.rows?.length ?? 0;
  lines.push(row(declared === 1 ? "1 item" : `${declared} items`));
  if (spec.headers?.length) lines.push(row(spec.headers.join(dense ? " " : "   ")));
  lines.push(rule);

  // Every line this function emits is counted, including the overflow marker:
  // it used to count four chrome rows and then append a fifth when the content
  // did not fit, so the frame came back taller than the budget it was handed.
  const height = Math.max(5, Math.floor(safeHeight));
  const chrome = 4 + (spec.headers?.length ? 1 : 0); // top, count, rule, bottom
  const wanted = spec.rows ?? [];

  // `code` and `detail` are drawn, on a continuation line under their own row.
  // The schema accepts and bounds both and the raster renders both, so on every
  // host that cannot draw a picture - tmux, ssh, a log - the character frame
  // was silently losing two fields the question might be about. Decided
  // 2026-10-02: draw them when they fit, and drop rows before the frame grows
  // past the height it was handed.
  const continuationOf = (entry: { code?: string; detail?: string }): string => {
    const parts = [entry.code, entry.detail].filter((part): part is string => Boolean(part && part.trim()));
    return parts.join("  ");
  };
  // Rows are admitted while the *lines* they need fit, so a frame of ten rows
  // that all carry a detail shows fewer rows rather than one row too many.
  let used = 0;
  const admitted: Array<(typeof wanted)[number]> = [];
  for (const entry of wanted) {
    const cost = 1 + (continuationOf(entry) ? 1 : 0);
    if (used + cost > Math.max(0, height - chrome)) break;
    used += cost;
    admitted.push(entry);
  }
  const shown = admitted;
  const overflows = wanted.length > shown.length;
  const dropTheRest = () => {
    const rest = wanted.length - shown.length;
    lines.push(row(`…and ${rest} more`));
  };

  // The tail is ` bar status`, and the longest status word is four characters,
  // so the tail needs six inner cells before the label is given any. Getting
  // this wrong truncates the status to "w…" and "l…", which is worse than not
  // drawing it: the reader cannot tell what the colour was going to say.
  const STATUS_CELLS = 6;
  const railCells = rail ? 4 : 0;
  const barCells = dense ? 0 : Math.max(6, Math.min(14, inner - railCells - STATUS_CELLS - 18));
  const labelCells = Math.max(8, inner - railCells - barCells - STATUS_CELLS);

  shown.forEach((entry, index) => {
    const mark = statusMark(entry.status);
    const left = rail ? `${pad(`${index + 1}`, 2)} ` : "";
    const label = pad(entry.label ?? "", labelCells);
    const tail = barCells > 0
      ? ` ${bar(entry.value ?? 0, barCells)}${mark ? ` ${mark}` : ""}`
      : mark ? ` ${mark}` : "";
    lines.push(row(`${left}${label}${tail}`));
    // Under its own row, indented past the label so it reads as that row's
    // detail and not as a row of its own.
    const continuation = continuationOf(entry);
    if (continuation) lines.push(row(`${left}     ${truncate(continuation, Math.max(1, inner - cells(left) - 5))}`));
  });
  if (overflows) {
    dropTheRest();
  }

  lines.push(bottom);
  return lines;
}
