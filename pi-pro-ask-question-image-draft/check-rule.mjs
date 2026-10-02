import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "./src/tui.ts";
import { normalizeReview } from "./src/schema.ts";

setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };

for (const n of [20, 6, 3]) {
  const review = normalizeReview({
    reviewId: "r", images: "on",
    stages: [{
      id: "s", header: "T", prompt: "Q?",
      options: Array.from({ length: n }, (_, i) => ({
        id: `o${i}`, label: `Option ${i + 1}`,
        image: { path: ".pi/benchmark/images/visual-001-option-1.png", alt: "x" },
        description: `Favors option ${i + 1}; a one-to-two sentence reason line.`,
      })),
    }],
  });
  const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44, columns: 100 } }, theme, review, process.cwd(), () => {});
  await new Promise((r) => setTimeout(r, 200));
  const frame = component.render(100).map((line) => line.replace(/\[[0-9;?]*[ -/]*[@-~]/g, ""));
  const rules = frame.map((line, i) => (/^[─]{10,}$/.test(line.trim()) ? i : -1)).filter((i) => i >= 0);
  const noteAt = frame.findIndex((line) => /Add note/.test(line));
  const choices = frame.filter((line) => /^\s*(>|>\s*)?\d+\.\s+Option/.test(line)).length;
  const reasons = frame.filter((line) => /^Favors option/.test(line)).length;
  const lastChoice = frame.map((line, i) => (/^\s*(>|>\s*)?\d+\.\s+Option/.test(line) ? i : -1)).filter((i) => i >= 0).pop();
  console.log(`n=${n} frame=${frame.length} choices=${choices} reasons=${reasons} rules=${JSON.stringify(rules)} ruleBetweenChoicesAndActions=${rules.some((r) => r > lastChoice && r < noteAt)}`);
  component.dispose();
}
