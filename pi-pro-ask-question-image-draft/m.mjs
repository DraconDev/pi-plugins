import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "/home/dracon/Dev/pi-plugins/pi-pro-ask-question-image-draft/src/tui.ts";
import { normalizeReview } from "/home/dracon/Dev/pi-plugins/pi-pro-ask-question-image-draft/src/schema.ts";
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const theme = { fg:(_c,t)=>t, bg:(_c,t)=>t, bold:(t)=>t, dim:(t)=>t, italic:(t)=>t, underline:(t)=>t, inverse:(t)=>t };
const row = (label, value) => [{ label, value: Number(value) }];
const opts = [
  { id:"a", label:"Transit airy", description:"Favors quick orientation; most whitespace, fewest metrics above the fold.",
    mockup:{ layout:"airy", title:"AIRY", header:"Operations", rows: row("On time","98.2%") } },
  { id:"b", label:"Transit split", description:"Favors scan-down comparison; a fixed rail on the left, live board on the right.",
    mockup:{ layout:"split", title:"SPLIT", header:"Operations", rows: row("On time","98.2%") } },
  { id:"c", label:"Transit dense", description:"Favors an operator who knows the system; everything visible at once, no scrolling.",
    mockup:{ layout:"dense", title:"DENSE", header:"Operations", rows: row("On time","98.2%") } },
  { id:"d", label:"Transit ledger", description:"Favors audit over speed; every value carries its own timestamp and origin.",
    mockup:{ layout:"rail", title:"LEDGER", header:"Operations", rows: row("On time","98.2%") } },
];
const review = normalizeReview({ reviewId:"m", images:"off", stages:[{ id:"s", header:"Treatment", multiSelect:false,
  prompt:"Which visual treatment should the operations dashboard open with?", options: opts }] });
const c = new VisualReviewWizard({ requestRender:()=>{}, terminal:{rows:44,columns:100} }, theme, review, process.cwd(), ()=>{});
const plain = (l)=>l.map(x=>x.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g,""));
for (let i=0;i<2;i+=1) c.handleInput("\u001b[B");
const f = plain(c.render(100));
console.log(`frame=${f.length} rows  choicesShown=${f.filter(l=>/^\s*(>\s*)?\d+\.\s+Transit/.test(l)).length}  reasonsShown=${f.filter(l=>/Favors/.test(l)).length}  dropped=${c.reasonsDropped}`);
const f2=plain(c.render(100)); console.log(f2.filter(l=>/density:/.test(l)).join("") || "(no density line)");

const frame = plain(c.render(100));
f2.forEach((l, i) => {
  const isArt = l.includes("\u001b_G");
  console.log(String(i).padStart(2) + " " + (isArt ? "   << the highlighted option's wireframe, drawn on the cell grid >>" : l));
});
