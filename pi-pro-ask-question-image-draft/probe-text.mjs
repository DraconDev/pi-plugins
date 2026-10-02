import { renderMockupText } from "./src/mockup-text.ts";
const spec = { layout: "airy", title: "TRANSIT AIRY", rows: [
  { label: "On time", value: 0.98, status: "ok" }, { label: "Active", value: 0.71, status: "warn" }, { label: "Delayed", value: 0.33, status: "danger" } ] };
const col = (line) => { let n = 0; for (const ch of line) { const c = ch.codePointAt(0);
  n += ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xff00 && c <= 0xff60)) ? 2 : 1; } return n; };
console.log("aligned?");
for (const w of [28, 40, 54, 72]) { const f = renderMockupText(spec, { width: w, height: 9 });
  console.log(`  width ${String(w).padStart(2)}: ${f.length} lines, distinct widths ${JSON.stringify([...new Set(f.map(col))])}`); }
console.log("height budget");
for (const h of [5, 6, 8, 9, 20]) { const f = renderMockupText({ ...spec, rows: Array.from({length:20},(_,i)=>({label:`Row ${i+1}`,value:0.5})) }, { width: 40, height: h });
  console.log(`  height ${String(h).padStart(2)}: emitted ${f.length} ${f.length <= h ? "OK" : "OVER"}`); }
console.log("hostile geometry");
for (const [w,h] of [[NaN,NaN],[-5,-5],[1e9,1e9],[0,0]]) { const f = renderMockupText(spec, { width: w, height: h });
  console.log(`  w=${w} h=${h}: ${f.length} lines, widths ${JSON.stringify([...new Set(f.map(col))])}`); }
console.log("CJK");
for (const l of renderMockupText({ ...spec, title: "日本語のタイトル", rows: [{ label: "運行状況", value: 0.9 }] }, { width: 40, height: 8 })) console.log(`  |${l}| ${col(l)} cols`);
