import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "./src/tui.ts";
import { normalizeReview } from "./src/schema.ts";

setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
const long = "Which treatment should the dashboard open with this winter, and how should priority service be signalled to operators on a night shift who need the answer without scrolling? ".repeat(3);
const review = normalizeReview({
  reviewId: "p", images: "on",
  stages: [{
    id: "s", header: "H", prompt: long,
    options: [
      { id: "a", label: "Option 1", mockup: { layout: "list", title: "T", rows: [{ label: "On time", value: 0.9 }] } },
      { id: "b", label: "Option 2", mockup: { layout: "list", title: "T", rows: [{ label: "On time", value: 0.8 }] } },
    ],
  }],
});
const wizard = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44, columns: 100 } }, theme, review, "/tmp", () => {});
wizard.render(100)
  .map((line) => line.replace(/\[[0-9;?]*[ -/]*[@-~]/g, ""))
  .filter((line) => /move|Ctrl\+R/.test(line))
  .forEach((line) => console.log("  ", line));
