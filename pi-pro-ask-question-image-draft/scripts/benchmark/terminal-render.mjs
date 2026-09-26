/**
 * Render an image at the dimensions a terminal actually shows it at.
 *
 * The objective requires the visual gate to be measured "at realistic terminal
 * dimensions", and the previous run asserted that in prose while handing the
 * judge the untouched 1024x1024 file. That is a different measurement: at full
 * resolution a mockup's fine structure is legible to a vision model and to
 * nobody sitting at a terminal, so the gate was scoring detail no user could
 * ever see.
 *
 * The grid is not a guess. `src/tui.ts` renders an option preview through
 * pi-tui's `Image` with `maxWidthCells: width - 2` and `maxHeightCells: 16`,
 * where `width` is the preview column: `min(36, max(26, floor(columns * 0.3)))`
 * for a terminal of at least 88 columns. So on a 110-column terminal the image a
 * user actually sees occupies 34 x 16 character cells. At the conventional
 * 8x16 pixel cell that is 272 x 256 device pixels, and that raster - area
 * averaged, because pure downscale wants an area kernel and not a point sample
 * - is the artifact the judge must look at.
 *
 * Decoding and encoding are done in plain TypeScript with no native dependency
 * on purpose: the judged path stays hermetic and `npm test` pins the exact pixel
 * maths.
 */
import { decodePng, encodePng, resampleArea } from "../../src/png.ts";

// The codec itself lives in `src/png.ts`: product code composes generated art
// into a cell-grid preview with the same decode and resample, and a measurement
// that used a private copy of the maths could drift from the pixels the product
// actually builds.
export { decodePng, encodePng, resampleArea } from "../../src/png.ts";

/** The preview geometry `src/tui.ts` gives an option image on a real terminal. */
export function previewCellGrid({ columns = 110, cellPixelWidth = 8, cellPixelHeight = 16, maxHeightCells = 16 } = {}) {
  const panel = Math.min(36, Math.max(26, Math.floor(columns * 0.3)));
  const widthCells = Math.max(1, panel - 2);
  return {
    columns,
    panelColumns: panel,
    widthCells,
    heightCells: maxHeightCells,
    pixelWidth: widthCells * cellPixelWidth,
    pixelHeight: maxHeightCells * cellPixelHeight,
  };
}

/** The raster a terminal user actually perceives for this image. */
export function renderAtTerminalDimensions(bytes, grid = previewCellGrid()) {
  const decoded = decodePng(bytes);
  const rendered = resampleArea(decoded, grid.pixelWidth, grid.pixelHeight);
  return { ...rendered, png: encodePng(rendered), source: { width: decoded.width, height: decoded.height }, grid };
}
