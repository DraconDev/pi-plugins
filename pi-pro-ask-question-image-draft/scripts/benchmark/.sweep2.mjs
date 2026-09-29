import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "../../src/tui.ts";
import { normalizeReview } from "../../src/schema.ts";
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const theme = { fg:(_c,t)=>t, bg:(_c,t)=>t, bold:(t)=>t, dim:(t)=>t, italic:(t)=>t, underline:(t)=>t, inverse:(t)=>t };
const image = new URL("file:///home/dracon/Dev/pi-plugins/pi-pro-ask-question-image-draft/.pi/benchmark/images/visual-001-option-1.png").pathname;
let fails = 0, cases = 0;
for (const kind of ["image", "preview", "changes"]) {
  for (const multi of [false, true]) {
    for (const density of ["comfortable", "compact"]) {
      for (const n of [20, 26]) {
        for (const rows of [24, 44]) {
          cases++;
          const review = normalizeReview({ reviewId:"s", images:"on", ...(density==="compact"?{density}:{}), stages:[{ id:"one", header:"T", prompt:"Pick", multiSelect: multi, options: Array.from({length:n},(_,i)=>{
            const base = { id:`o${i}`, label:`Option ${i+1}`, description:`Favors option ${i+1}; trade-off: a one-to-two sentence reason line.` };
            if (kind === "image") return { ...base, image: { path: image, alt: "F" } };
            if (kind === "preview") return { ...base, preview: "a short preview block" };
            return { ...base, changes: [`change one for option ${i+1}`, "change two"] };
          }) }]});
          const w = new VisualReviewWizard({requestRender:()=>{},terminal:{rows}}, theme, review, process.cwd(), ()=>{});
          await new Promise(r=>setTimeout(r, kind==="image"?600:100));
          const marked = new Set(); let overflow = false; const seen = new Set();
          for (let i = 0; i < n; i++) {
            const p = w.render(110).map(l=>l.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,""));
            const m = p.find(l=>/^\s*>\s*(?:\d+\.\s+|\[[ x]\]\s+)Option \d+\s*$/.test(l));
            if (m) marked.add(/Option (\d+)/.exec(m)[1]);
            for (const l of p) { const s=/^\s*>?\s*(?:\d+\.\s+|\[[ x]\]\s+)Option (\d+)\s*$/.exec(l); if (s) seen.add(s[1]); }
            if (/[↑↓]\s*\d+\s+more/.test(p.join("\n"))) overflow = true;
            if (i < n-1) w.handleInput("\u001b[B");
          }
          const ok = marked.size === n && seen.size === n;
          if (!ok) { fails++; console.log(`FAIL kind=${kind} multi=${multi} ${density} n=${n} rows=${rows} marked=${marked.size}/${n} everSeen=${seen.size}/${n} overflow=${overflow}`); }
          w.dispose();
        }
      }
    }
  }
}
console.log(`cases=${cases} failing configurations: ${fails}`);
