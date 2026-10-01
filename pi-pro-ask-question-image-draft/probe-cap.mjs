import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "./src/tui.ts";
import { normalizeReview } from "./src/schema.ts";
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const th = { fg:(_c,t)=>t, bg:(_c,t)=>t, bold:(t)=>t, dim:(t)=>t, italic:(t)=>t, underline:(t)=>t, inverse:(t)=>t };
const plain=(l)=>l.map(x=>x.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g,""));
for (const n of [2,3,4,5,6]) {
  const review = normalizeReview({ reviewId:"c", images:"off", stages:[{ id:"s", header:"T", prompt:"Which?",
    options: Array.from({length:n},(_,i)=>({ id:`o${i}`, label:`Option ${i+1}`, description:`Favors option ${i+1}; a reason line.`,
      mockup:{ layout:"airy", title:"OPS", rows:[{label:"On time",value:0.9},{label:"Active",value:0.7},{label:"Delayed",value:0.3}] } })) }] });
  const c = new VisualReviewWizard({ requestRender:()=>{}, terminal:{rows:44,columns:100} }, th, review, process.cwd(), ()=>{});
  const f = plain(c.render(100));
  const reasons = f.filter(l=>/^Favors /.test(l)).length;
  const artRows = f.filter(l=>/\u001b_G/.test(l)).length;
  console.log(`mockup n=${n}: reasons=${reasons} dropped=${c.reasonsDropped}`);
  c.dispose();
}
