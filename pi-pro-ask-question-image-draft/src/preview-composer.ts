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

export interface ComposeOptions {
  spec: MockupSpec;
  art: DecodedImage;
  widthCells?: number;
  heightCells?: number;
  /**
   * How far the art is washed towards white before the structure goes on top,
   * 0..1. A vector layout on a white background needs almost no wash; artwork
   * with a dark or saturated ground needs most of it, or the annotation is
   * unreadable and the whole point of the composition is lost.
   */
  scrim?: number;
  style?: { frame: Rgb };
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
  // The art is scaled to fill the *whole* frame, not a band cut out of it. A
  // generated layout is square and its content sits in horizontal rows, so a
  // wide band crops to the gaps between rows and the preview came out white -
  // the art was there and simply never shown.
  const scaled = cropToFill(art, width, height);
  const canvas = new Canvas(width, height, style.background);
  canvas.drawRgb(scaled, 0, 0);
  // Wash: the annotation has to be readable over whatever the art brought with
  // it, and the amount is bounded rather than tuned per image.
  canvas.fillRectAlpha(0, 0, width, height, [255, 255, 255], options.scrim ?? 0.55);
  // The structure is drawn on its own canvas and keyed onto the art: only the
  // ink survives, so the rows and the arrangement are always legible while the
  // artwork still shows through everywhere they are not.
  const structure = renderMockupCanvas(spec, { widthCells, heightCells });
  canvas.overlayKeyed(structure, 0, 0, [style.background, style.surface]);
  const frame = options.style?.frame ?? DEFAULT_FRAME;
  canvas.strokeRect(0, 0, width, height, frame, 1);
  return { png: encodeCanvasPng(canvas), width: canvas.width, height: canvas.height };
}

/** Compose straight from generated PNG bytes, which is the shape the callers have. */
export function composePreviewFromPng(spec: MockupSpec, artPng: Buffer, options: Omit<ComposeOptions, "spec" | "art"> = {}): { png: Buffer; width: number; height: number } {
  return composePreview({ ...options, spec, art: decodeArt(artPng) });
}
