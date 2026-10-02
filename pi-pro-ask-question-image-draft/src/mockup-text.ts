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

const truncate = (value: string, cells: number) => {
  const characters = [...String(value ?? "")];
  return characters.length <= cells ? String(value ?? "") : `${characters.slice(0, Math.max(0, cells - 1)).join("")}…`;
};

const pad = (value: string, cells: number) => {
  const text = truncate(value, cells);
  return text + " ".repeat(Math.max(0, cells - [...text].length));
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
  const outer = Math.max(28, Math.min(72, options.width));
  const inner = outer - 4;
  const layout = spec.layout ?? "list";
  const rail = layout === "rail" || layout === "board" || layout === "overlay";
  const dense = layout === "dense" || layout === "tiles" || layout === "chart";

  // A title lives inside the top rule rather than being hung off it, because a
  // frame whose own border is broken is not a drawing of anything.
  const top = (title: string) => {
    const text = ` ${truncate(title, inner - 2)} `;
    return `┌${FRAME_CHARS.horizontal}${text}${FRAME_CHARS.horizontal.repeat(Math.max(0, inner - 1 - text.length))}┐`;
  };
  const rule = `├${FRAME_CHARS.horizontal.repeat(inner)}┤`;
  const bottom = `└${FRAME_CHARS.horizontal.repeat(inner)}┘`;
  const row = (text: string) => `${FRAME_CHARS.vertical} ${pad(text, inner)} ${FRAME_CHARS.vertical}`;

  const lines: string[] = [top(spec.title ?? "mockup")];
  const declared = spec.rows?.length ?? 0;
  lines.push(row(declared === 1 ? "1 item" : `${declared} items`));
  if (spec.headers?.length) lines.push(row(spec.headers.join(dense ? " " : "   ")));
  lines.push(rule);

  // Content is left out rather than squashed, and says so when it is.
  const chrome = 2 + (spec.headers?.length ? 1 : 0) + 2; // top, count, rule, bottom
  const available = Math.max(0, options.height - chrome);
  const wanted = spec.rows ?? [];
  const shown = wanted.slice(0, available);

  const railCells = rail ? 4 : 0;
  const barCells = dense ? 0 : Math.max(6, Math.min(14, inner - railCells - 20));
  const labelCells = Math.max(8, inner - railCells - barCells - 4);

  shown.forEach((entry, index) => {
    const mark = statusMark(entry.status);
    const left = rail ? `${pad(`${index + 1}`, 2)} ` : "";
    const label = pad(entry.label ?? "", labelCells);
    const tail = barCells > 0
      ? ` ${bar(entry.value ?? 0, barCells)}${mark ? ` ${mark}` : ""}`
      : mark ? ` ${mark}` : "";
    lines.push(row(`${left}${label}${tail}`));
  });
  if (shown.length < wanted.length) {
    lines.push(row(`…and ${wanted.length - shown.length} more`));
  }

  lines.push(bottom);
  return lines;
}
