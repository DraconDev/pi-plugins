import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "./src/tui.ts";
import { normalizeReview } from "./src/schema.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
const root = mkdtempSync(join(tmpdir(), "shield-probe-"));
writeFileSync(join(root, "inside.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));
const { loadImage } = await import("./src/image-loader.ts");

console.log("— url host restriction —");
for (const url of [
  "http://169.254.169.254/latest/meta-data/",
  "http://localhost:8080/x.png",
  "http://127.0.0.1/x.png",
  "http://10.0.0.5/x.png",
  "https://example.com/x.png",
]) {
  try {
    await loadImage({ url }, root);
    console.log(`  ${url.padEnd(40)} fetched`);
  } catch (error) {
    console.log(`  ${url.padEnd(40)} refused: ${String(error.message).slice(0, 58)}`);
  }
}

console.log("— declared mimeType over hostile bytes —");
writeFileSync(join(root, "text.png"), "this is definitely not a png, it is just words\n".repeat(50));
try {
  await loadImage({ path: "text.png", mimeType: "image/png" }, root);
  console.log("  a text file declared image/png was ACCEPTED");
} catch (error) {
  console.log(`  a text file declared image/png refused: ${String(error.message).slice(0, 70)}`);
}

console.log("— stacked prompt clamp —");
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const long = "Which treatment should the operations dashboard open with this winter, and how should the priority service be signalled to operators who are on a night shift and need the answer without scrolling? ".repeat(3);
const review = normalizeReview({
  reviewId: "p", images: "on",
  stages: [{ id: "s", header: "H", prompt: long, options: [
    { id: "a", label: "Option 1", image: { path: join(root, "inside.png"), alt: "x" } },
    { id: "b", label: "Option 2", image: { path: join(root, "inside.png"), alt: "x" } },
  ] }],
});
const wizard = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44, columns: 100 } }, theme, review, root, () => {});
await new Promise((r) => setTimeout(r, 150));
const frame = wizard.render(100).map((l) => l.replace(/\[[0-9;?]*[ -/]*[@-~]/g, ""));
console.log(`  promptClamped=${wizard.promptClamped}  marker on screen=${frame.some((l) => /Ctrl\+R to read it all/.test(l))}`);
console.log(`  hints offer Ctrl+R: ${/Ctrl\+R prompt/.test(frame.join(" "))}`);
wizard.handleInput("");
const expanded = wizard.render(100).map((l) => l.replace(/\[[0-9;?]*[ -/]*[@-~]/g, ""));
console.log(`  after Ctrl+R the clamp marker is gone: ${!expanded.some((l) => /Ctrl\+R to read it all/.test(l))}`);
