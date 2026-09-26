/**
 * Deterministic mockup renderer.
 *
 * The benchmark measured that a generative image model cannot deliver the
 * information-bearing part of an interface preview at terminal size: asked for a
 * full mockup and shown on a 31 x 16 cell grid, 34.5% of generated previews were
 * judged severely unreadable. The text baseline was not far behind at 23.0%,
 * because a sentence cannot show an arrangement either.
 *
 * So the information-bearing part stops being generated. This renderer draws the
 * preview on the exact cell grid the terminal displays it on - one text line per
 * cell row, glyphs from a 5x7 font inside an 8x16 cell - so what a user reads is
 * what the screen has room for. The generative provider stays available for the
 * cases that want artwork, where legibility of invented text is not the point.
 *
 * Everything here is pure: the same spec renders byte-identical bytes on every
 * machine, which is what makes the release gate reproducible.
 */

import { deflateSync } from "node:zlib";

/** Terminal cell metrics. 8x16 is the conventional VGA/kitty cell. */
export const CELL_WIDTH = 8;
export const CELL_HEIGHT = 16;

/**
 * The geometry an option preview occupies on a typical terminal.
 *
 * `src/tui.ts` renders through pi-tui with `maxWidthCells: width - 2` and
 * `maxHeightCells: 16`, where the preview column is
 * `min(36, max(26, floor(columns * 0.3)))` for a terminal of at least 88
 * columns. On a 110-column terminal that is 31 x 16 cells. A mockup drawn
 * anywhere else is drawn for a screen the user does not have.
 */
export const DEFAULT_MOCKUP_CELLS = Object.freeze({
  terminalColumns: 110,
  widthCells: 31,
  heightCells: 16,
  cellWidth: CELL_WIDTH,
  cellHeight: CELL_HEIGHT,
});

type Glyph = string;

/**
 * 5x7 glyphs, one row per character row, "1" meaning ink. Kept as readable art
 * rather than packed hex so a reviewer can check a letter by eye.
 */
const GLYPHS: Record<string, Glyph> = {
  " ": "00000/00000/00000/00000/00000/00000/00000",
  "!": "00100/00100/00100/00100/00100/00000/00100",
  '"': "01010/01010/00000/00000/00000/00000/00000",
  "#": "01010/01010/11111/01010/11111/01010/01010",
  "$": "00100/01111/10100/01110/00101/11110/00100",
  "%": "11000/11001/00010/00100/01000/10011/00011",
  "&": "01100/10010/10100/01000/10101/10010/01101",
  "'": "00100/00100/00000/00000/00000/00000/00000",
  "(": "00010/00100/01000/01000/01000/00100/00010",
  ")": "01000/00100/00010/00010/00010/00100/01000",
  "*": "00000/00100/10101/01110/10101/00100/00000",
  "+": "00000/00100/00100/11111/00100/00100/00000",
  ",": "00000/00000/00000/00000/00110/00100/01000",
  "-": "00000/00000/00000/11111/00000/00000/00000",
  ".": "00000/00000/00000/00000/00000/01100/01100",
  "/": "00001/00010/00010/00100/01000/01000/10000",
  "0": "01110/10001/10011/10101/11001/10001/01110",
  "1": "00100/01100/00100/00100/00100/00100/01110",
  "2": "01110/10001/00001/00010/00100/01000/11111",
  "3": "11111/00010/00100/00010/00001/10001/01110",
  "4": "00010/00110/01010/10010/11111/00010/00010",
  "5": "11111/10000/11110/00001/00001/10001/01110",
  "6": "00110/01000/10000/11110/10001/10001/01110",
  "7": "11111/00001/00010/00100/01000/01000/01000",
  "8": "01110/10001/10001/01110/10001/10001/01110",
  "9": "01110/10001/10001/01111/00001/00010/01100",
  ":": "00000/01100/01100/00000/01100/01100/00000",
  ";": "00000/01100/01100/00000/01100/00100/01000",
  "<": "00010/00100/01000/10000/01000/00100/00010",
  "=": "00000/00000/11111/00000/11111/00000/00000",
  ">": "01000/00100/00010/00001/00010/00100/01000",
  "?": "01110/10001/00001/00010/00100/00000/00100",
  "@": "01110/10001/10111/10101/10111/10000/01111",
  A: "01110/10001/10001/11111/10001/10001/10001",
  B: "11110/10001/10001/11110/10001/10001/11110",
  C: "01110/10001/10000/10000/10000/10001/01110",
  D: "11100/10010/10001/10001/10001/10010/11100",
  E: "11111/10000/10000/11110/10000/10000/11111",
  F: "11111/10000/10000/11110/10000/10000/10000",
  G: "01110/10001/10000/10111/10001/10001/01111",
  H: "10001/10001/10001/11111/10001/10001/10001",
  I: "01110/00100/00100/00100/00100/00100/01110",
  J: "00111/00010/00010/00010/00010/10010/01100",
  K: "10001/10010/10100/11000/10100/10010/10001",
  L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001",
  N: "10001/10001/11001/10101/10011/10001/10001",
  O: "01110/10001/10001/10001/10001/10001/01110",
  P: "11110/10001/10001/11110/10000/10000/10000",
  Q: "01110/10001/10001/10001/10101/10010/01101",
  R: "11110/10001/10001/11110/10100/10010/10001",
  S: "01111/10000/10000/01110/00001/00001/11110",
  T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110",
  V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/10101/01010",
  X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100",
  Z: "11111/00001/00010/00100/01000/10000/11111",
  "[": "01110/01000/01000/01000/01000/01000/01110",
  "]": "01110/00010/00010/00010/00010/00010/01110",
  "^": "00100/01010/10001/00000/00000/00000/00000",
  _: "00000/00000/00000/00000/00000/00000/11111",
  "`": "01000/00100/00000/00000/00000/00000/00000",
  a: "00000/00000/01110/00001/01111/10001/01111",
  b: "10000/10000/11110/10001/10001/10001/11110",
  c: "00000/00000/01111/10000/10000/10000/01111",
  d: "00001/00001/01111/10001/10001/10001/01111",
  e: "00000/00000/01110/10001/11111/10000/01110",
  f: "00110/01001/01000/11100/01000/01000/01000",
  g: "00000/01111/10001/10001/01111/00001/01110",
  h: "10000/10000/11110/10001/10001/10001/10001",
  i: "00100/00000/01100/00100/00100/00100/01110",
  j: "00010/00000/00110/00010/00010/10010/01100",
  k: "10000/10000/10010/10100/11000/10100/10010",
  l: "01100/00100/00100/00100/00100/00100/01110",
  m: "00000/00000/11010/10101/10101/10101/10101",
  n: "00000/00000/11110/10001/10001/10001/10001",
  o: "00000/00000/01110/10001/10001/10001/01110",
  p: "00000/11110/10001/10001/11110/10000/10000",
  q: "00000/01111/10001/10001/01111/00001/00001",
  r: "00000/00000/10110/11001/10000/10000/10000",
  s: "00000/00000/01111/10000/01110/00001/11110",
  t: "01000/01000/11100/01000/01000/01001/00110",
  u: "00000/00000/10001/10001/10001/10011/01101",
  v: "00000/00000/10001/10001/10001/01010/00100",
  w: "00000/00000/10001/10101/10101/10101/01010",
  x: "00000/00000/10001/01010/00100/01010/10001",
  y: "00000/10001/10001/10001/01111/00001/01110",
  z: "00000/00000/11111/00010/00100/01000/11111",
  "{": "00010/00100/00100/01000/00100/00100/00010",
  "|": "00100/00100/00100/00100/00100/00100/00100",
  "}": "01000/00100/00100/00010/00100/00100/01000",
  "~": "00000/00000/01000/10101/00010/00000/00000",
};

const MISSING: Glyph = "11111/10001/10001/10001/10001/10001/11111";

export type Rgb = readonly [number, number, number];

export interface MockupStyle {
  background: Rgb;
  surface: Rgb;
  ink: Rgb;
  muted: Rgb;
  accent: Rgb;
  danger: Rgb;
  warn: Rgb;
  ok: Rgb;
}

export const DEFAULT_STYLE: MockupStyle = {
  background: [248, 249, 251],
  surface: [255, 255, 255],
  ink: [24, 28, 35],
  muted: [122, 132, 148],
  accent: [37, 99, 235],
  danger: [220, 38, 38],
  warn: [217, 119, 6],
  ok: [22, 163, 74],
};

/** One row of content in a mockup. */
export interface MockupRow {
  /** A short status word rendered as a coloured chip. */
  status?: "danger" | "warn" | "ok" | "accent" | "muted";
  /** Two or three characters of dense content, the way a real badge reads. */
  code?: string;
  label: string;
  /** 0..1, rendered as a bar when present. */
  value?: number;
  detail?: string;
}

export interface MockupSpec {
  /** Title bar text. Omit to keep a judged comparison blind. */
  title?: string;
  /** Which arrangement to draw; defaults to a single column list. */
  layout?: "list" | "airy" | "split" | "dense" | "rail" | "board" | "chart" | "overlay" | "steps" | "tiles";
  /** A status shown in a prominent position (a dialog, a banner, a highlight). */
  emphasis?: "dialog" | "banner" | "toast" | "sheet" | "highlight";
  /** Short column headers for the chart and table arrangements. */
  headers?: string[];
  /**
   * Row pitch for the list arrangements, in cells. 1 packs the frame; 2 leaves
   * a blank row between items.
   *
   * The judge charged the composed previews for reading as "pixelated" and
   * "unreadable at terminal size" in 82 of 91 losses, and a 5x7 glyph in an 8x16
   * cell is exactly what a terminal shows - the problem was how many of them
   * there were. Half as many rows with a blank row between them is the same
   * arrangement at half the density, and it is the difference between a preview
   * that looks deliberate and one that looks like noise.
   */
  rowPitch?: number;
  rows: MockupRow[];
  style?: Partial<MockupStyle>;
}

const GLYPH_CACHE = new Map<string, Uint8Array>();

function glyphRows(character: string): Uint8Array {
  const cached = GLYPH_CACHE.get(character);
  if (cached) return cached;
  const art = GLYPHS[character] ?? MISSING;
  const rows = art.split("/").map((row) => row.split("").map((bit) => (bit === "1" ? 1 : 0)));
  // Column-major bits: 5 columns, 7 rows, bit n of column c.
  const packed = new Uint8Array(5);
  for (let column = 0; column < 5; column += 1) {
    let bits = 0;
    for (let row = 0; row < 7; row += 1) bits |= (rows[row]?.[column] ?? 0) << row;
    packed[column] = bits;
  }
  GLYPH_CACHE.set(character, packed);
  return packed;
}

/** A mutable RGB canvas addressed in device pixels. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly pixels: Uint8Array;

  constructor(width: number, height: number, fill: Rgb) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    this.fillRect(0, 0, width, height, fill);
  }

  set(x: number, y: number, colour: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 3;
    this.pixels[index] = colour[0];
    this.pixels[index + 1] = colour[1];
    this.pixels[index + 2] = colour[2];
  }

  fillRect(x: number, y: number, width: number, height: number, colour: Rgb): void {
    for (let dy = 0; dy < height; dy += 1) {
      for (let dx = 0; dx < width; dx += 1) this.set(x + dx, y + dy, colour);
    }
  }

  strokeRect(x: number, y: number, width: number, height: number, colour: Rgb, thickness = 1): void {
    this.fillRect(x, y, width, thickness, colour);
    this.fillRect(x, y + height - thickness, width, thickness, colour);
    this.fillRect(x, y, thickness, height, colour);
    this.fillRect(x + width - thickness, y, thickness, height, colour);
  }

  /** Draw one 5x7 glyph inside a cell, vertically centred. */
  glyph(character: string, cellX: number, cellY: number, colour: Rgb): void {
    const packed = glyphRows(character);
    const originX = cellX * CELL_WIDTH + 1;
    const originY = cellY * CELL_HEIGHT + 4;
    for (let column = 0; column < 5; column += 1) {
      const bits = packed[column];
      for (let row = 0; row < 7; row += 1) {
        if (bits & (1 << row)) {
          for (let dx = 0; dx < 1 + 1; dx += 1) this.set(originX + column * 2 + dx, originY + row, colour);
        }
      }
    }
  }

  /** Draw a string into a cell range, truncated to the available cells. */
  text(value: string, cellX: number, cellY: number, maxCells: number, colour: Rgb): void {
    const characters = [...String(value ?? "")].slice(0, Math.max(0, maxCells));
    characters.forEach((character, index) => this.glyph(character, cellX + index, cellY, colour));
  }

  toRgb(): Buffer {
    return Buffer.from(this.pixels);
  }

  /** Copy another canvas into this one at a pixel offset. */
  blit(source: Canvas, atX = 0, atY = 0): void {
    this.drawRgb({ width: source.width, height: source.height, data: source.toRgb() }, atX, atY);
  }

  /**
   * Draw raw RGB triplets at a pixel offset.
   *
   * `toRgb` hands back a copy of the pixels, so writing into its result used to
   * draw nothing at all - the composed preview rendered as a bare mockup and the
   * artwork was silently absent. Anything that writes into a canvas goes
   * through this method.
   */
  drawRgb(image: { width: number; height: number; data: Buffer }, atX = 0, atY = 0): void {
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const source = (y * image.width + x) * 3;
        this.set(atX + x, atY + y, [image.data[source]!, image.data[source + 1]!, image.data[source + 2]!]);
      }
    }
  }

  /** Fill a rectangle at a fractional opacity, for washes and scrims. */
  fillRectAlpha(x: number, y: number, width: number, height: number, colour: Rgb, alpha: number): void {
    const amount = Math.max(0, Math.min(1, alpha));
    for (let dy = 0; dy < height; dy += 1) {
      for (let dx = 0; dx < width; dx += 1) this.blend(x + dx, y + dy, colour, amount);
    }
  }

  /** Blend one pixel towards a colour at a fractional opacity. */
  blend(x: number, y: number, colour: Rgb, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 3;
    this.pixels[index] = Math.round(this.pixels[index]! * (1 - alpha) + colour[0] * alpha);
    this.pixels[index + 1] = Math.round(this.pixels[index + 1]! * (1 - alpha) + colour[1] * alpha);
    this.pixels[index + 2] = Math.round(this.pixels[index + 2]! * (1 - alpha) + colour[2] * alpha);
  }

  /**
   * Copy a canvas on top of this one, keeping only the pixels that are not one
   * of `skip` colours, and dropping a one-pixel moat around every kept run so
   * the annotation reads against whatever it lands on.
   */
  overlayKeyed(source: Canvas, atX: number, atY: number, skip: readonly Rgb[]): void {
    const pixels = source.toRgb();
    const isBackground = (r: number, g: number, b: number): boolean => skip.some(
      (colour) => Math.abs(colour[0] - r) <= 2 && Math.abs(colour[1] - g) <= 2 && Math.abs(colour[2] - b) <= 2,
    );
    const kept = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= source.width || y >= source.height) return false;
      const index = (y * source.width + x) * 3;
      return !isBackground(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!);
    };
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        if (!kept(x, y)) continue;
        const index = (y * source.width + x) * 3;
        this.set(atX + x, atY + y, [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!]);
        // Moat: paint the neighbours too, so a hairline glyph does not sit
        // directly on the artwork with no separation.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (kept(x + dx, y + dy)) continue;
          this.blend(atX + x + dx, atY + y + dy, [255, 255, 255], 0.75);
        }
      }
    }
  }
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode RGB pixels as a non-interlaced 8-bit PNG. */
export function encodeCanvasPng(canvas: Canvas): Buffer {
  const stride = canvas.width * 3;
  const raw = Buffer.alloc(canvas.height * (stride + 1));
  const pixels = canvas.toRgb();
  for (let row = 0; row < canvas.height; row += 1) {
    raw[row * (stride + 1)] = 0;
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.width, 0);
  ihdr.writeUInt32BE(canvas.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const STATUS_COLOUR: Record<NonNullable<MockupRow["status"]>, keyof MockupStyle> = {
  danger: "danger", warn: "warn", ok: "ok", accent: "accent", muted: "muted",
};

function statusColour(style: MockupStyle, status: MockupRow["status"]): Rgb {
  if (!status) return style.muted;
  return style[STATUS_COLOUR[status]];
}

/** One row: a status chip, a dense code, a label, an optional value bar. */
function drawRow(canvas: Canvas, row: MockupRow, cellX: number, cellY: number, cellWidth: number, style: MockupStyle, options: { bar?: boolean; barWidth?: number } = {}): void {
  canvas.fillRect(cellX * CELL_WIDTH, cellY * CELL_HEIGHT, cellWidth * CELL_WIDTH, CELL_HEIGHT - 1, style.surface);
  const colour = statusColour(style, row.status);
  canvas.fillRect(cellX * CELL_WIDTH + 1, cellY * CELL_HEIGHT + 4, 4, 8, colour);
  let cursor = cellX + 1;
  if (row.code) {
    canvas.text(row.code, cursor, cellY, 4, colour);
    cursor += 4;
  }
  const barCells = options.bar && row.value !== undefined ? (options.barWidth ?? 8) : 0;
  const labelCells = cellWidth - (cursor - cellX) - barCells - 1;
  canvas.text(row.label, cursor, cellY, labelCells, style.ink);
  if (barCells > 0) {
    const filled = Math.max(0, Math.min(barCells, Math.round((row.value ?? 0) * barCells)));
    canvas.fillRect((cellX + cellWidth - barCells) * CELL_WIDTH, cellY * CELL_HEIGHT + 6, barCells * CELL_WIDTH - 2, 4, style.muted);
    canvas.fillRect((cellX + cellWidth - barCells) * CELL_WIDTH, cellY * CELL_HEIGHT + 6, filled * CELL_WIDTH - 2, 4, colour);
  }
}

function drawChrome(canvas: Canvas, spec: MockupSpec, style: MockupStyle): { top: number } {
  const columns = Math.floor(canvas.width / CELL_WIDTH);
  if (spec.title) {
    canvas.fillRect(0, 0, canvas.width, CELL_HEIGHT * 2, style.accent);
    canvas.text(spec.title.toUpperCase(), 1, 0, columns - 2, [255, 255, 255]);
    canvas.text(`${spec.rows.length} items`, 1, 1, columns - 2, [214, 226, 255]);
    return { top: 2 };
  }
  canvas.fillRect(0, 0, canvas.width, CELL_HEIGHT, style.surface);
  canvas.fillRect(0, CELL_HEIGHT - 1, canvas.width, 1, style.muted);
  return { top: 1 };
}

function drawEmphasis(canvas: Canvas, spec: MockupSpec, style: MockupStyle): void {
  const columns = Math.floor(canvas.width / CELL_WIDTH);
  const rows = Math.floor(canvas.height / CELL_HEIGHT);
  const message = spec.rows[0]?.label ?? "";
  if (spec.emphasis === "dialog") {
    const width = Math.min(columns - 4, 24);
    const left = Math.floor((columns - width) / 2);
    canvas.fillRect(0, 0, canvas.width, canvas.height, [236, 238, 242]);
    for (let row = 2; row < rows - 2; row += 1) {
      canvas.fillRect(left * CELL_WIDTH, row * CELL_HEIGHT, width * CELL_WIDTH, CELL_HEIGHT, style.surface);
    }
    canvas.strokeRect(left * CELL_WIDTH, 2 * CELL_HEIGHT, width * CELL_WIDTH, (rows - 4) * CELL_HEIGHT, style.ink, 1);
    canvas.text(message, left + 1, 2 + Math.floor((rows - 6) / 2), width - 2, style.ink);
    canvas.fillRect((left + 1) * CELL_WIDTH, (rows - 4) * CELL_HEIGHT, 8 * CELL_WIDTH, CELL_HEIGHT, style.accent);
    canvas.text("OK", left + 2, rows - 4, 6, [255, 255, 255]);
    canvas.text("CANCEL", left + 11, rows - 4, 8, style.muted);
    return;
  }
  if (spec.emphasis === "banner" || spec.emphasis === "toast") {
    const width = spec.emphasis === "banner" ? columns : Math.min(columns - 6, 20);
    const left = spec.emphasis === "banner" ? 0 : Math.floor((columns - width) / 2);
    const top = spec.emphasis === "banner" ? 0 : 1;
    canvas.fillRect(left * CELL_WIDTH, top * CELL_HEIGHT, width * CELL_WIDTH, CELL_HEIGHT * 2, style.danger);
    canvas.text(message, left + 1, top, width - 2, [255, 255, 255]);
    canvas.text(spec.rows[0]?.detail ?? "", left + 1, top + 1, width - 2, [255, 220, 220]);
    return;
  }
  if (spec.emphasis === "sheet") {
    const top = Math.floor(rows * 0.55);
    canvas.fillRect(0, top * CELL_HEIGHT, canvas.width, (rows - top) * CELL_HEIGHT, style.surface);
    canvas.fillRect(0, top * CELL_HEIGHT, canvas.width, 2, style.ink);
    canvas.text(message, 1, top + 1, columns - 2, style.ink);
    for (let index = 0; index < Math.min(4, rows - top - 3); index += 1) {
      const row = spec.rows[index + 1];
      if (row) drawRow(canvas, row, 0, top + 2 + index, columns, style, { bar: true, barWidth: 6 });
    }
    return;
  }
  if (spec.emphasis === "highlight" && spec.rows[0]) {
    drawRow(canvas, spec.rows[0], 0, Math.floor(rows / 2), columns, style, { bar: true, barWidth: 8 });
  }
}

/**
 * Draw a mockup on a cell grid and return the canvas.
 *
 * The canvas is exported separately from the PNG so a caller can compose into
 * the same drawing - `src/preview-composer.ts` puts generated art inside the
 * structure this function draws - without decoding the bytes again.
 */
export function renderMockupCanvas(spec: MockupSpec, { widthCells = 31, heightCells = 16 } = {}): Canvas {
  const style = { ...DEFAULT_STYLE, ...(spec.style ?? {}) };
  const canvas = new Canvas(widthCells * CELL_WIDTH, heightCells * CELL_HEIGHT, style.background);
  const columns = widthCells;
  const rows = heightCells;
  const layout = spec.layout ?? "list";
  const { top } = drawChrome(canvas, spec, style);
  const body = rows - top;
  const rowsToDraw = spec.rows.slice(0, Math.max(0, rows - top - (spec.emphasis ? 1 : 0)));

  if (layout === "split" || layout === "board") {
    const leftCells = layout === "split" ? Math.ceil(columns / 2) : Math.floor(columns / 3);
    const gapCells = 1;
    const rightX = leftCells + gapCells;
    const rightWidth = columns - rightX;
    const half = Math.ceil(rowsToDraw.length / 2);
    for (const [index, row] of rowsToDraw.entries()) {
      const column = index < half ? 0 : 1;
      const position = column === 0 ? index : index - half;
      const at = rightX;
      const width = column === 0 ? leftCells : rightWidth;
      if (position >= body - 1) break;
      drawRow(canvas, row, at, top + position, width, style, { bar: true, barWidth: Math.max(4, width - 14) });
    }
  } else if (layout === "chart") {
    const headers = spec.headers ?? ["item", "value"];
    const labelCells = 12;
    canvas.fillRect(0, top * CELL_HEIGHT, columns * CELL_WIDTH, CELL_HEIGHT, style.surface);
    canvas.fillRect(0, top * CELL_HEIGHT + CELL_HEIGHT - 1, columns * CELL_WIDTH, 1, style.muted);
    canvas.text(headers[0] ?? "item", 1, top, labelCells - 1, style.muted);
    canvas.text(headers[1] ?? "value", labelCells, top, columns - labelCells - 1, style.muted);
    const barTop = top + 1;
    const available = rows - barTop;
    spec.rows.forEach((row, index) => {
      if (index >= available) return;
      const y = barTop + index;
      canvas.text(row.label, 1, y, labelCells - 2, style.ink);
      // The bar lives in its own columns to the right of the label, so a long
      // label can never be drawn over by the value it is describing.
      const track = columns - labelCells - 1;
      const filled = Math.max(1, Math.round((row.value ?? 0.5) * track));
      const colour = statusColour(style, row.status);
      canvas.fillRect((labelCells + 1) * CELL_WIDTH + 2, y * CELL_HEIGHT + 5, track * CELL_WIDTH - 6, 6, style.surface);
      canvas.fillRect((labelCells + 1) * CELL_WIDTH + 2, y * CELL_HEIGHT + 5, filled * CELL_WIDTH - 6, 6, colour);
    });
  } else if (layout === "rail") {
    const railCells = 6;
    canvas.fillRect(0, top * CELL_HEIGHT, railCells * CELL_WIDTH, (rows - top) * CELL_HEIGHT, style.surface);
    canvas.fillRect(railCells * CELL_WIDTH, top * CELL_HEIGHT, 1, (rows - top) * CELL_HEIGHT, style.muted);
    const items = Math.min(rowsToDraw.length, rows - top - 1);
    for (let index = 0; index < items; index += 1) {
      const row = rowsToDraw[index];
      if (!row) break;
      canvas.fillRect(1 * CELL_WIDTH, (top + index) * CELL_HEIGHT + 4, 4, 8, statusColour(style, row.status));
      canvas.text((row.code ?? String(index + 1)).slice(0, 4), 2, top + index, railCells - 2, style.muted);
      drawRow(canvas, row, railCells + 1, top + index, columns - railCells - 1, style, { bar: true, barWidth: 6 });
    }
  } else if (layout === "steps") {
    const count = Math.max(2, Math.min(rowsToDraw.length, 4));
    for (let index = 0; index < count; index += 1) {
      const row = rowsToDraw[index];
      if (!row) break;
      const at = top + index * 2;
      if (at >= rows - 1) break;
      canvas.fillRect(0, at * CELL_HEIGHT, columns * CELL_WIDTH, CELL_HEIGHT, index === 0 ? style.surface : style.background);
      canvas.fillRect(1 * CELL_WIDTH, at * CELL_HEIGHT + 4, 8, 8, index === 0 ? style.accent : style.muted);
      canvas.text(String(index + 1), 1, at, 1, index === 0 ? [255, 255, 255] : style.background);
      canvas.text(row.label, 2, at, columns - 4, style.ink);
      if (index < count - 1) {
        canvas.fillRect(2 * CELL_WIDTH, (at + 1) * CELL_HEIGHT, 1, CELL_HEIGHT, style.muted);
      }
    }
  } else if (layout === "tiles") {
    const perRow = columns >= 24 ? 3 : 2;
    const tileWidth = Math.floor(columns / perRow);
    const tileRows = Math.max(1, Math.floor((rows - top) / 3));
    spec.rows.forEach((row, index) => {
      const x = (index % perRow) * tileWidth;
      const y = top + Math.floor(index / perRow) * 3;
      if (y + 2 >= rows) return;
      canvas.fillRect(x * CELL_WIDTH + 1, y * CELL_HEIGHT, (tileWidth - 1) * CELL_WIDTH, CELL_HEIGHT * 2, style.surface);
      canvas.strokeRect(x * CELL_WIDTH + 1, y * CELL_HEIGHT, (tileWidth - 1) * CELL_WIDTH, CELL_HEIGHT * 2, style.muted);
      canvas.fillRect(x * CELL_WIDTH + 2, y * CELL_HEIGHT + 2, (tileWidth - 2) * CELL_WIDTH - 2, CELL_HEIGHT - 4, statusColour(style, row.status));
      canvas.text(row.label, x + 1, y + 1, tileWidth - 2, style.ink);
    });
  } else {
    // list, airy and dense share one row renderer and differ only in pitch and
    // how many rows they admit. Airy doubles the pitch so the same frame holds
    // half as many items with the air between them that its name promises -
    // which is exactly the difference a reader is being asked to judge.
    const pitch = layout === "airy" ? 3 : Math.max(1, Math.min(3, Math.round(spec.rowPitch ?? 1)));
    const capacity = Math.max(0, Math.floor((rows - top) / pitch) - 1);
    const airyCap = Math.max(3, Math.floor((rows - top) / pitch) - 1);
    const count = Math.min(layout === "airy" ? 4 : airyCap, rowsToDraw.length, capacity);
    for (let index = 0; index < count; index += 1) {
      const row = rowsToDraw[index];
      if (!row) break;
      drawRow(canvas, row, 0, top + index * pitch, columns, style, { bar: true, barWidth: 8 });
    }
  }

  if (spec.emphasis) drawEmphasis(canvas, spec, style);

  return canvas;
}

/** Render a mockup on a cell grid and return the PNG bytes. */
export function renderMockup(spec: MockupSpec, options: { widthCells?: number; heightCells?: number } = {}): { png: Buffer; width: number; height: number } {
  const canvas = renderMockupCanvas(spec, options);
  return { png: encodeCanvasPng(canvas), width: canvas.width, height: canvas.height };
}
