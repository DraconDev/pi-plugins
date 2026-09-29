import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "/home/dracon/Dev/pi-plugins/pi-pro-ask-question-image-draft/src/tui.ts";
import { normalizeReview } from "/home/dracon/Dev/pi-plugins/pi-pro-ask-question-image-draft/src/schema.ts";
import { fileURLToPath } from "node:url";
setCapabilities({ images: null, trueColor: true, hyperlinks: false });
delete process.env.TMUX;
const real = fileURLToPath(new URL("file:///home/dracon/Dev/pi-plugins/pi-pro-ask-question-image-draft/tests/fixtures/tui-smoke.png"));
const review = normalizeReview({
  images: "on",
  reviewId: "no-images",
  stages: [{ id: "one", header: "One", prompt: "Pick", options: [
    { id: "a", label: "A", image: { path: real, alt: "fixture" } },
    { id: "b", label: "B", image: { path: real, alt: "fixture" } },
  ] }],
});
const w = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, { fg:(_c,t)=>t, bg:(_c,t)=>t, bold:(t)=>t, dim:(t)=>t, italic:(t)=>t, underline:(t)=>t, inverse:(t)=>t }, review, process.cwd(), () => {});
const prose = w.render(110).join(" ").replace(/\s+/g, " ");
console.log("first 400:", prose.slice(0, 400));
