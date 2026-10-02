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
writeFileSync(join(root, "text.png"), "this is definitely not a png, it is only words\n".repeat(50));
const { loadImage } = await import("./src/image-loader.ts");

const attempt = async (reference) => {
  try {
    await loadImage(reference, root);
    return "accepted";
  } catch (error) {
    return `refused: ${String(error.message).slice(0, 56)}`;
  }
};

console.log("— a real image inside the review's directory —");
console.log(`  ${await attempt({ path: "inside.png" })}`);
console.log("— a text file wearing a .png extension —");
console.log(`  ${await attempt({ path: "text.png" })}`);
console.log(`  ${await attempt({ path: "text.png", mimeType: "image/png" })}`);

setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const long = "Which treatment should the operations dashboard open with this winter, and how should priority service be signalled to operators on a night shift who need the answer without scrolling? ".repeat(3);
const review = normalizeReview({
  reviewId: "p", images: "on",
  stages: [{ id: "s", header: "H", prompt: long, options: [
    { id: "a", label: "Option 1", image: { path: join(root, "inside.png"), alt: "x" } },
    { id: "b", label: "Option 2", image: { path: join(root, "inside.png"), alt: "x" } },
  ] }],
});
const wizard = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44, columns: 100 } }, theme, review, root, () => {});
await new Promise((r) => setTimeout(r, 150));
const plain = (w) => w.render(100).map((l) => l.replace(/\[[0-9;?]*[ -\/]*[@-~]/g, ""));
const first = plain(wizard);
console.log("— the stacked prompt clamp —");
console.log(`  clamped=${wizard.promptClamped}  marker shown=${first.some((l) => /Ctrl\+R to read it all/.test(l))}  hint offers Ctrl+R=${/Ctrl\+R prompt/.test(first.join(" "))}`);
wizard.handleInput("");
const second = plain(wizard);
console.log(`  after Ctrl+R: marker gone=${!second.some((l) => /Ctrl\+R to read it all/.test(l))}  prompt spans ${second.filter((l) => l.includes("night shift")).length} lines`);
