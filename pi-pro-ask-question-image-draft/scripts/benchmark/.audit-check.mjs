import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "../../src/tui.ts";
import { normalizeReview } from "../../src/schema.ts";
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const theme = { fg:(_c,t)=>t, bg:(_c,t)=>t, bold:(t)=>t, dim:(t)=>t, italic:(t)=>t, underline:(t)=>t, inverse:(t)=>t };
const fixture = new URL("file:///home/dracon/Dev/pi-plugins/pi-pro-ask-question-image-draft/tests/fixtures/tiny.png").pathname;
// exactly the sizes the audit named
for (const [n, rows] of [[8,40],[8,44],[10,40],[10,44],[11,40],[14,40],[8,36],[10,36]]) {
  const review = normalizeReview({ reviewId:"m", images:"on", stages:[{id:"one",header:"T",prompt:"Which ships?",options:Array.from({length:n},(_,i)=>({id:`o${i}`,label:`Option ${i+1}`,description:`Favors option ${i+1}; trade-off: a one-to-two sentence reason line.`,image:{path:fixture,alt:"F"}}))}]});
  const w = new VisualReviewWizard({requestRender:()=>{},terminal:{rows}}, theme, review, process.cwd(), ()=>{});
  await new Promise((r)=>setTimeout(r,250));
  const f = w.render(100);
  const p = f.map(l=>l.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g,""));
  const has=(re)=>p.some(l=>re.test(l));
  const panel = Math.max(14, Math.min(rows-5, 32));
  console.log(`n=${String(n).padStart(2)} rows=${rows} total=${String(f.length).padStart(2)} panel=${panel} withinPanel=${f.length<=panel} hints=${has(/↑↓ move/)} auto=${has(/auto-resolve/)} dens=${has(/density:/)} border=${/^─+$/.test(p[p.length-1]??"")}`);
  w.dispose();
}
