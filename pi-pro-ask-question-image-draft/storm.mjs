import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "./src/tui.ts";
import { normalizeReview } from "./src/schema.ts";
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const theme = { fg:(_c,t)=>t, bg:(_c,t)=>t, bold:(t)=>t, dim:(t)=>t, italic:(t)=>t, underline:(t)=>t, inverse:(t)=>t };
const IMAGE = ".pi/benchmark/images/visual-001-option-1.png";
const why = (n,k)=>`Favors ${k}; a one-to-two sentence reason line for this option, ${n}.`;
const review = normalizeReview({ reviewId:"storm", images:"on", round:2, rounds:4, title:"Winter service review", stages:[
  { id:"treatment", header:"Dashboard treatment", multiSelect:false, prompt:"Which visual treatment should the operations dashboard open with this winter?",
    options:["airy","split","dense","ledger","grid","stack"].map((layout,i)=>({ id:`t${i}`, label:`Transit ${layout}`,
      description: why(i+1,["quick orientation","scan-down comparison","known operators","audit over speed","uniform tiles","nested detail"][i]),
      mockup:{ layout, title:`TRANSIT ${layout.toUpperCase()}`, rows:[{label:"On time",value:0.9},{label:"Active",value:0.7},{label:"Delayed",value:0.3}] } })) },
  { id:"routes", header:"Route priority", multiSelect:true, prompt:"Which routes should keep priority service through the freeze?",
    options:["North loop","South loop","Canal cut","Harbour spur","Ring road","Valley line","Quarry way","Old towpath","Market cross","Ford end"].map((label,i)=>({ id:`r${i}`, label, description: why(i+1,["commuters","schools","hospital","depot","freight","markets","residents","tourism","night shift","bridge works"][i]) })) },
  { id:"photo", header:"Signage", multiSelect:false, prompt:"Which signage treatment should the stops carry?",
    options:["Frosted panel","Reflective band","High-contrast","Retrofitted","Temporary vinyl"].map((label,i)=>({ id:`p${i}`, label,
      description: why(i+1,["low light","sleet","distance reading","consistency","fast rollout"][i]), image:{ path: IMAGE, alt:"A signage treatment" } })) },
] });
const c = new VisualReviewWizard({ requestRender:()=>{}, terminal:{rows:44, columns:100} }, theme, review, process.cwd(), ()=>{});
await new Promise(r=>setTimeout(r,250));
const plain=(l)=>l.map(x=>x.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g,""));
const show=(stage, downs)=>{ c.selectedIndex=0; c.stageIndex=stage;
  for(let i=0;i<downs;i+=1) c.handleInput("\u001b[B");
  const f=plain(c.render(100));
  f.forEach((l,i)=>console.log(String(i).padStart(2), l.replace(/\u001b_G.*$/u,"   << wireframe / picture >>"))); };
console.log("STAGE 1 of 3 — Dashboard treatment (model-drawn wireframes)\n");
show(0,2);
