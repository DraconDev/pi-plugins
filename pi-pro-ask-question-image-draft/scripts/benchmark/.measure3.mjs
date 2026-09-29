import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "../../src/tui.ts";
import { normalizeReview } from "../../src/schema.ts";
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const theme = { fg:(_c,t)=>t, bg:(_c,t)=>t, bold:(t)=>t, dim:(t)=>t, italic:(t)=>t, underline:(t)=>t, inverse:(t)=>t };
const fixture = new URL("file:///home/dracon/Dev/pi-plugins/pi-pro-ask-question-image-draft/tests/fixtures/tiny.png").pathname;
for (const [n, rows, extra] of [[2,40,{}],[8,40,{}],[10,40,{}],[14,40,{}],[20,40,{}],[20,40,{density:"compact"}]]) {
  const review = normalizeReview({ reviewId: "m", images: "on", ...extra, stages: [{ id: "one", header: "T", prompt: "Which ships?", options: Array.from({length:n},(_,i)=>({id:`o${i}`,label:`Option ${i+1}`,description:`Favors option ${i+1}; trade-off: a one-to-two sentence reason line.`,image:{path:fixture,alt:"F"}})) }]});
  const w = new VisualReviewWizard({requestRender:()=>{},terminal:{rows}}, theme, review, process.cwd(), ()=>{});
  await new Promise((r)=>setTimeout(r,300));
  const f = w.render(100);
  const p = f.map(l=>l.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g,""));
  const has = (re) => p.some(l=>re.test(l));
  console.log(`n=${n} rows=${rows} ${JSON.stringify(extra)} total=${f.length} hints=${has(/↑↓ move/)} auto=${has(/auto-resolve/)} dens=${has(/density:/)} border=${/^─+$/.test(p[p.length-1]??"")} reasons=${p.filter(l=>/Favors option/.test(l)).length} art=${f.some(l=>l.includes("\u001b_G"))}`);
  w.dispose();
}
