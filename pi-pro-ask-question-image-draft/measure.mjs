import { TOOL_DESCRIPTION, PROMPT_GUIDELINES } from "./extensions/visual-review.ts";

console.log("TOOL_DESCRIPTION chars:", TOOL_DESCRIPTION.length);
console.log("guidelines chars:", PROMPT_GUIDELINES.reduce((n, s) => n + s.length, 0));
console.log("mentions images switch:", /\bimages\b/.test(TOOL_DESCRIPTION));
