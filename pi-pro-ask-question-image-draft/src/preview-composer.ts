/**
 * Composed preview: generated art inside the package's own structure.
 *
 * Why this exists
 * ---------------
 * The benchmark answered a question the first prompt architecture could not. A
 * generated image is judged on the raster a terminal shows - about 279 x 279
 * pixels for the 31 x 16 cell preview grid - and at that size the model can
 * produce *legible* and *distinguishable* art but almost never the
 * information-bearing detail the question asks about: the delayed route, the
 * blocked release, the bin below its threshold. The measured severe-failure
 * rate for a raw generated preview was 34.5% before the display-budget prompt
 * and stayed an order of magnitude above the 2% ceiling after it, with the
 * judge's own words naming the same defect each time - "abstract
 * placeholder-like symbols", "contain no identifiable route, delay, or action
 * information".
 *
 * The defect is not the model. It is the division of labour. A 279-pixel
 * raster can carry a *shape* and an *emphasis*; it cannot carry a sentence.
 * So the information-bearing layer stops being generated, and the generated
 * image becomes what it is actually good at: the visual character of the
 * treatment.
 *
 * `composePreview` therefore draws the deterministic structure first - the same
 * `MockupSpec` the package renders when no art exists, so a preview is never
 * less informative than the text presentation - and then places the generated
 * art into the focal region of that structure, cropped to fill rather than
 * squashed, with a one-pixel frame so the boundary between the two layers is
 * visible instead of guessed at.
 *
 * Everything is deterministic given (spec, art): the same bytes on every
 * machine, which is what lets the release gate be re-measured rather than
 * re-argued.
 */
import { CELL_HEIGHT, CELL_WIDTH, Canvas, DEFAULT_MOCKUP_CELLS, DEFAULT_STYLE, encodeCanvasPng, renderMockupCanvas, type MockupSpec, type Rgb } from "./mockup-renderer.ts";
import { decodePng, resampleArea, type RgbImage } from "./png.ts";

export type DecodedImage = RgbImage;

/**
 * Rows of artwork at the top of the frame, in a 16-row preview.
 *
 * A control run over the same 40 cases measured what the split buys: with six
 * rows the judge read 32/40 as wins but charged nine severe, complaining that
 * the drawn rows were "pixelated" and "partially illegible" - a 5x7 glyph in an
 * 8x16 cell is exactly what a terminal shows and it still reads as crude when a
 * vision model inspects a 248 x 256 raster. The artwork is the layer that can be
 * as large as it likes, so the frame gives most of itself to the artwork and
 * keeps just enough rows to keep the arrangement and its emphasis readable.
 */
export const DEFAULT_ART_ROWS = 9;

export interface ComposeOptions {
  spec: MockupSpec;
  art: DecodedImage;
  widthCells?: number;
  heightCells?: number;
  /**
   * Height of the art panel, in cells, measured from the top of the frame.
   * Defaults to 6 of 16, which leaves ten rows for the structure: the rows are
   * what the reader decides from, so the artwork is the smaller half of the
   * frame. An earlier version gave the art the whole frame with the structure
   * keyed over it, and the judge read the result as "severely corrupted and
   * overlaid with oversized text and shapes" in 69% of cases - two layers in
   * one small raster is mud, not composition.
   */
  artRows?: number;
  /** "fit" letterboxes the whole artwork into the panel; "crop" fills it. */
  artMode?: "fit" | "crop";
  style?: { frame: Rgb; panel: Rgb };
}

const DEFAULT_FRAME: Rgb = [24, 28, 35];

/**
 * Crop-to-fill: take the largest centred source rectangle with the target
 * aspect, then resample it. A squashed image distorts the shapes the treatment
 * is judged on, so the crop happens first.
 */
export function cropToFill(art: DecodedImage, targetWidth: number, targetHeight: number): DecodedImage {
  if (art.width <= 0 || art.height <= 0) throw new Error("Art image has no pixels.");
  const targetAspect = targetWidth / targetHeight;
  const sourceAspect = art.width / art.height;
  let width = art.width;
  let height = art.height;
  if (sourceAspect > targetAspect) width = Math.max(1, Math.round(art.height * targetAspect));
  else height = Math.max(1, Math.round(art.width / targetAspect));
  const left = Math.floor((art.width - width) / 2);
  const top = Math.floor((art.height - height) / 2);
  const cropped = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const source = ((top + y) * art.width + left) * 3;
    art.data.copy(cropped, y * width * 3, source, source + width * 3);
  }
  return resampleArea({ width, height, data: cropped }, targetWidth, targetHeight);
}

/** Decode a generated PNG into the composer's pixel form. */
export function decodeArt(bytes: Buffer): DecodedImage {
  return decodePng(bytes);
}

/**
 * Draw the structure, place the art inside it, and return the PNG.
 *
 * The art band starts one cell below the chrome so the structure's own header
 * row stays visible, and it is framed so a user can see where the artwork ends
 * and the rows begin - a preview that blurs its two layers is worse than one
 * that admits it has two.
 */
export function composePreview(options: ComposeOptions): { png: Buffer; width: number; height: number } {
  const { spec, art } = options;
  const widthCells = options.widthCells ?? DEFAULT_MOCKUP_CELLS.widthCells;
  const heightCells = options.heightCells ?? DEFAULT_MOCKUP_CELLS.heightCells;
  const style = { ...DEFAULT_STYLE, ...(spec.style ?? {}) };
  const width = widthCells * CELL_WIDTH;
  const height = heightCells * CELL_HEIGHT;
  const artRows = Math.max(2, Math.min(heightCells - 4, options.artRows ?? DEFAULT_ART_ROWS));
  const canvas = new Canvas(width, height, style.background);
  const panel = options.style?.panel ?? style.background;
  canvas.fillRect(0, 0, width, artRows * CELL_HEIGHT, panel);
  // The artwork is shown whole. Cropping a square layout to a wide band cuts
  // through the gaps between its rows and the panel comes out empty, which is
  // how an earlier revision lost the art entirely while still "composing".
  const available = { width: width - 4, height: artRows * CELL_HEIGHT - 4 };
  const scale = Math.min(available.width / art.width, available.height / art.height, 1);
  const placed = scale < 1
    ? resampleArea(art, Math.max(1, Math.round(art.width * scale)), Math.max(1, Math.round(art.height * scale)))
    : art;
  const atX = Math.floor((width - placed.width) / 2);
  const atY = Math.floor((artRows * CELL_HEIGHT - placed.height) / 2);
  canvas.drawRgb(placed, atX, atY);
  const frame = options.style?.frame ?? DEFAULT_FRAME;
  canvas.strokeRect(0, 0, placed.width + atX * 2, placed.height + atY * 2, frame, 1);
  canvas.fillRect(0, artRows * CELL_HEIGHT - 1, width, 1, frame);
  // The structure is laid out in the rows the panel does not take, so each
  // arrangement picks a capacity that fits instead of being clipped.
  const structure = renderMockupCanvas(spec, { widthCells, heightCells: heightCells - artRows });
  canvas.blit(structure, 0, artRows * CELL_HEIGHT);
  return { png: encodeCanvasPng(canvas), width: canvas.width, height: canvas.height };
}

/** Compose straight from generated PNG bytes, which is the shape the callers have. */
export function composePreviewFromPng(spec: MockupSpec, artPng: Buffer, options: Omit<ComposeOptions, "spec" | "art"> = {}): { png: Buffer; width: number; height: number } {
  return composePreview({ ...options, spec, art: decodeArt(artPng) });
}
