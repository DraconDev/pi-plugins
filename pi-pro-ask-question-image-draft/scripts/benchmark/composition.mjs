/**
 * Compositions that survive the terminal downscale.
 *
 * Why this module exists
 * ----------------------
 * The visual gate measures the candidate arm on the raster a terminal actually
 * displays: `scripts/benchmark/terminal-render.mjs` rescales each 1024x1024
 * generation onto the 31 x 16 cell grid `src/tui.ts` gives an option preview,
 * which is about 279 x 279 device pixels. That is a 3.7x reduction, so a source
 * feature has to be roughly 15-20 pixels wide before one display pixel carries
 * it. The style the pipeline used to send asked for the opposite: thin dark
 * outlines, "fill the frame", "every region contains interface elements", and
 * placeholder words inside the chrome. A diffusion model answered that with a
 * full-density interface mockup - dozens of hairline rows and 8-pixel type -
 * and after the downscale it measured as texture: the three treatments of a
 * scenario turned into three shades of the same grey grid, which is exactly the
 * "the three treatments cannot be told apart at that size" severe failure the
 * judge charged 34.5% of candidate cases for.
 *
 * So the prompt is now written in the units the display can resolve. Every
 * treatment resolves to a *countable* composition - two panels, three stacked
 * blocks, a three-by-three grid - and the style spends its budget on a handful
 * of large solid shapes instead of on detail. Counting is the point: a model can
 * be told "exactly two panels" and drawn "an interface with good information
 * hierarchy" and only one of those survives contact with a 279-pixel raster.
 *
 * Nothing here samples or calls a provider. A composition is a pure function of
 * the option, so the prompt-hash cache, the 600-image budget, and the blinded
 * comparison all stay reproducible.
 */

/**
 * The display the image is judged at. Kept in one place because the style text
 * quotes it: a prompt that says "postage stamp" without saying how small is
 * advice, not a specification.
 */
export const TERMINAL_DISPLAY = Object.freeze({
  widthCells: 31,
  heightCells: 16,
  pixelWidth: 279,
  pixelHeight: 279,
  reductionFromSource: 1024 / 279,
  /** Smallest source feature that still covers a display pixel. */
  minimumSourceFeaturePx: 15,
});

/**
 * Arrangement families.
 *
 * `blocks` is the number of large elements the composition is made of and
 * `draw` is the countable instruction. `content` names what a block may contain
 * so the image still carries decision information instead of becoming the
 * content-free rectangles an earlier prompt revision produced.
 */
export const FAMILIES = Object.freeze({
  single: {
    blocks: 1,
    draw: "one large block filling two thirds of the frame, with two much smaller blocks tucked into the remaining corner",
    content: "the large block holds one oversized shape - a solid disc, a triangle or a thick bar - and the small blocks stay plain",
  },
  column: {
    blocks: 3,
    draw: "three wide blocks stacked in a single column, each the same width, separated by wide white gaps",
    content: "each block holds one oversized shape - a solid disc, a triangle or a thick bar - centred in the block",
  },
  column2: {
    blocks: 2,
    draw: "two very wide blocks stacked in a single column, each the same width, separated by one wide white gap",
    content: "each block holds one oversized shape - a solid disc, a triangle or a thick bar - centred in the block",
  },
  column4: {
    blocks: 4,
    draw: "four wide blocks stacked in a single column, each the same width, separated by wide white gaps",
    content: "each block holds one oversized shape, alternating between a solid disc and a thick bar",
  },
  split: {
    blocks: 2,
    draw: "two large panels side by side, each half the width and the full height, separated by one thick white gutter",
    content: "each panel holds two oversized shapes, a disc and a thick bar, and the left panel is the accent colour",
  },
  grid: {
    blocks: 9,
    draw: "a three-by-three grid of nine large square cells with thick white gutters between them",
    content: "each cell holds one oversized shape, and six of the nine cells are the accent colour while three stay white",
  },
  matrix: {
    blocks: 9,
    draw: "a three-by-three grid of nine large square cells with thick white gutters, and the cells are either solid black or pure white",
    content: "four cells are solid black, one cell is the accent colour, and the remaining cells are white outlines",
  },
  tiles: {
    blocks: 4,
    draw: "a two-by-two grid of four large square tiles with thick white gutters between them",
    content: "each tile holds one oversized shape, and the top-left tile is the accent colour",
  },
  band: {
    blocks: 3,
    draw: "one full-width band across the top third of the frame, with two half-width blocks side by side underneath it",
    content: "the band is the accent colour and holds one oversized shape; the two blocks below each hold a thick bar",
  },
  rail: {
    blocks: 2,
    draw: "one narrow tall block pinned to the left edge, with one wide block filling the rest of the frame",
    content: "the narrow block holds three stacked discs and the wide block holds two oversized shapes",
  },
  overlay: {
    blocks: 2,
    draw: "one large panel floating in the centre over a much fainter, oversized shape behind it that the panel clearly overlaps",
    content: "the front panel is the accent colour and holds one oversized shape; the shape behind it is a large pale disc",
  },
  stack: {
    blocks: 3,
    draw: "three large rectangles of visibly different sizes, each one overlapping the one behind it, offset so every layer is still seen",
    content: "the front rectangle is the accent colour and the two behind it are plain outlines",
  },
  flow: {
    blocks: 3,
    draw: "three large blocks in a single left-to-right row, joined by two thick arrows",
    content: "each block holds one oversized shape and the middle block is the accent colour",
  },
  tree: {
    blocks: 4,
    draw: "one large block at the top with two lines running down to two large blocks below it, and one line running from the left block to a fourth block beneath it",
    content: "each block holds one oversized shape and only the top block is the accent colour",
  },
  stages: {
    blocks: 3,
    draw: "three wide vertical bands side by side, each the same width, separated by thick white gutters, the leftmost band noticeably shorter than the other two",
    content: "each band holds one oversized shape and the middle band is the accent colour",
  },
  list: {
    blocks: 4,
    draw: "four wide short blocks stacked in a single column with wide white gaps, each block starting with one large square marker on its left",
    content: "each block holds one oversized shape and the first block is the accent colour",
  },
  chart: {
    blocks: 5,
    draw: "one very large rectangular plot area filling the frame, with five thick vertical bars of clearly different heights standing on one shared baseline inside it",
    content: "the tallest bar is the accent colour, the others are solid black, and the baseline is a thick black rule",
  },
  gauge: {
    blocks: 3,
    draw: "three large circles in a single row, each the same size, with one thick pointer line inside each circle",
    content: "the middle circle is the accent colour, the outer two are white with black outlines, and the pointers point in different directions",
  },
  map: {
    blocks: 3,
    draw: "one large rectangular field filling the frame, containing one thick winding path and two oversized round markers, one at each end of the path",
    content: "the field is pale, the path is a thick solid black line, and the marker at the destination end is the accent colour",
  },
  timeline: {
    blocks: 3,
    draw: "one very thick vertical spine running the full height of the frame, with three oversized discs sitting on it at even spacing",
    content: "the top disc is the accent colour and the other two are solid black",
  },
  hub: {
    blocks: 4,
    draw: "one very large disc in the centre with three clearly smaller discs around it, each joined to the centre by one thick straight line",
    content: "the centre disc is the accent colour and the three outer discs are solid black outlines",
  },
  icon: {
    blocks: 3,
    draw: "three very large simple shapes in a single row, each inside its own square cell, with thick white gutters between the cells",
    content: "each shape is a plain disc, triangle or square, and the middle one is the accent colour",
  },
});

/** Treatment vocabulary -> arrangement family. */
export const TREATMENT_FAMILIES = Object.freeze({
  // Density and focus
  explained: "tiles", durable: "column", outline: "single", single: "single", bubbles: "chart",
  markers: "map", band: "band", dash: "tiles", dashboard2: "grid", faithful: "tiles",
  literal: "grid", brand: "tiles", solid: "stack", friendly: "tiles",
  airy: "column", spacious: "column", minimal: "column2", simple: "column2", compact: "column",
  focused: "single", focus: "single", overview: "tiles", context: "split", hero: "single",
  glance: "tiles", complete: "grid", detail: "grid", dense: "grid", wide: "band",
  comfortable: "column", generous: "column", bold: "single", solid: "single", heavy: "grid",
  filled: "grid", mixed: "grid", balanced: "split", contrast: "split", plain: "column2",
  flat: "column2", system: "grid", plain2: "column2",

  // Structure
  split: "split", paired: "split", pairedleft: "split", pairedright: "split", columns: "split",
  column: "column", multi: "grid", board: "grid", board2: "grid", layered: "stack", layers: "stack",
  nested: "stack", stack: "stack", stacked: "stack", stack2: "stack", inset: "tiles",
  progressive: "column4", staged: "stages", stages: "stages", stage: "stages", phases: "stages",
  phased: "stages", swimlane: "stages", lanes: "stages", lane: "stages", ribbon: "stages",
  bands: "stages", splitview: "split",

  // Sequential / relational
  steps: "flow", step: "flow", linear: "flow", flow: "flow", pipeline: "flow", cycle: "flow",
  loop: "flow", pipes: "flow", schematic: "flow", diagram: "flow", arrows: "flow", guided: "flow",
  traceable: "flow", trace: "flow", route: "map", routes: "map", path: "map", map: "map",
  zones: "map", zone: "map", sites: "map", basin: "map", geographic: "map", chromosome: "map",
  locus: "map", treemap: "map", wayfinding: "map", itinerary: "map", timeline: "timeline",
  events: "timeline", history: "timeline", sequence: "flow", tree: "tree", dag: "tree",
  hierarchy: "tree", branches: "tree", graph: "hub", network: "hub", mesh: "hub", hub: "hub",
  connections: "hub", nodes: "hub", sinks: "map", sankey: "flow", graph2: "hub",

  // Dense data
  dense2: "grid", grid: "grid", matrix: "matrix", matrix2: "matrix", matrixgrid: "matrix",
  cells: "matrix", rows: "list", checklist: "list", exact: "grid", table: "grid", list: "list",
  queue: "list", ranked: "list", rank: "list", priority: "list", scores: "list", badges: "list",
  review: "list", evidence: "list", rules: "list", groups: "list", grouped: "list", tabs: "band",
  filter: "band", strip: "band", breadcrumb: "band", pagination: "list", search: "list",
  accordion: "list", card: "tiles", cards: "tiles", tiles: "tiles", tiles2: "tiles", symbols: "tiles",
  icons: "icon", icon: "icon", hex: "grid", hexagon: "grid", quadrant: "tiles", quad: "tiles",
  calendar: "grid", heatmap: "grid", heat: "grid", sparkline: "chart", multiples: "grid",
  portlet: "grid", grid2: "grid", scatter: "chart", plot: "chart", bars: "chart", bar: "chart",
  line: "chart", lines: "chart", curve: "chart", curves: "chart", trend: "chart", band2: "chart",
  bins: "chart", histogram: "chart", distribution: "chart", range: "chart", interval: "chart",
  waterfall: "chart", diverging: "chart", density: "chart", gradient: "chart", mix: "chart",
  composition: "chart", spread: "chart", comparison: "chart", compare: "chart", ranking: "chart",
  gantt: "chart", radar: "gauge", gauge: "gauge", rings: "gauge", donut: "gauge", pyramid: "chart",
  funnel: "chart", scorecard: "tiles", summary: "tiles", summary2: "tiles", progress: "stages",
  levels: "stages",

  // Placement
  rail2: "rail", rail: "rail", sidebar: "rail", portal: "rail", navigation: "rail", shelf: "band",
  overlay2: "overlay", overlay: "overlay", sheet: "overlay", sheet2: "overlay", modal: "overlay",
  dialog: "overlay", toast: "overlay", banner: "band", elevated: "overlay", drawer: "overlay",
  inline: "list", inline2: "list", note: "list", notes: "list", live: "list", toggle: "list",
  wizard: "flow", scroll: "column", pages: "split", zoom: "tiles", highlight: "single", hide: "single",
  panels: "split", panel: "single", front: "single", background: "single", surface: "single",
  frontmatter: "single",

  // Content shape
  narrative: "column", story: "column", "3d": "tiles", digest: "list", thread: "column", thread2: "column",
  editorial: "column", feed: "list", transcript: "list", log: "list", changelog: "list",
  profile: "single", portrait: "single", portrait2: "single", illustration: "single", artwork: "single",
  heroimage: "single", image: "single", photo: "single", friendly: "single", empty: "single",
  playful: "tiles", geometric: "tiles", planar: "tiles", shapes: "tiles", type: "single",
  typographic: "single", text: "single", label: "single", word: "single", preview: "single",
  finder: "single", searchbar: "list", color: "tiles", colour: "tiles", duotone: "grid",
  close: "single", deep: "single", zoomed: "tiles", dashboard: "grid", console: "grid",
  desk: "grid", screen: "grid", view: "grid", surface2: "single", multimodal: "grid", hybrid: "split",
  frozen: "single", freeze: "single", static: "single", painterly: "single", textured: "tiles",
  paper: "single", print: "single", slide: "single", deck: "tiles", video: "single", chart2: "chart",
  metric: "chart", kpi: "tiles", stat: "tiles", stats: "tiles", number: "tiles", numeric: "grid",
  code: "list", terminal: "list", diff: "split", compare2: "split", sidebyside: "split",
  lead: "single", headline: "single", statement: "single", pitch: "single", brief: "single",
  submit: "single", form: "list", input: "list", fields: "list", settings: "list", preference: "list",
  option: "tiles", options: "tiles", choice: "tiles", choices: "tiles", variant: "tiles",
  variants: "tiles", plan: "list", plans: "list", tier: "list", tiers: "list", price: "tiles",
  region: "map", world: "map", network2: "hub", cluster: "hub", clusters: "hub", fleet: "map",
  schedule: "timeline", calendar2: "grid", agenda: "list", day: "grid", week: "grid", month: "grid",
});

/** Description cues for treatments the table does not name. Order is significant. */
export const DESCRIPTION_CUES = Object.freeze([
  [/side by side|paired|alongside|two (?:panels|columns|views|blocks)|split/i, "split"],
  [/stack|layer|nest|overlay|modal|drawer|float|dimmed behind|on top of/i, "stack"],
  [/step|pipeline|flow|sequence|arrow|then |stage by stage|linear|process/i, "flow"],
  [/hierarch|branch|tree|parent|child|rolls? up/i, "tree"],
  [/chart|bar|trend|graph|distribution|series|metric|value|plot/i, "chart"],
  [/map|route|path|location|region|geograph|territor/i, "map"],
  [/timeline|chronolog|over time|history|sequence of events/i, "timeline"],
  [/gauge|dial|meter|needle|ring/i, "gauge"],
  [/grid|table|matrix|cell|calendar|board|heat/i, "grid"],
  [/list|row|queue|checklist|rank|item|feed|inbox|thread/i, "list"],
  [/band|header|full-width|across the top|strip|banner/i, "band"],
  [/column|airy|spacious|roomy|generous|single focus|scrolly/i, "column"],
]);

/** Families a description cue may not fall back to, worst legibility first. */
const ROTATION = Object.freeze(["single", "tiles", "column", "split", "grid", "flow", "chart", "stages", "stack", "list", "band", "map"]);

/** Stable 32-bit string hash; the last-resort composition has to be reproducible. */
function hash32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The last meaningful word of the option label names the treatment. */
export function treatmentKey(option) {
  const label = String(option?.label ?? "").trim();
  const words = label.split(/[\s-]+/).filter(Boolean);
  return (words.at(-1) ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve one option's composition.
 *
 * Three steps, in order of how much they can be trusted: the treatment
 * vocabulary names the arrangement; the option's own description carries the
 * arrangement in prose when the vocabulary does not; and only when neither
 * speaks does a stable hash of the option's own words pick a family, so the
 * three treatments of a scenario never collapse onto one identical composition
 * by accident. `source` records which step answered, and the report counts them.
 *
 * `siblings` are the other options of the same stage. A vocabulary key that two
 * of them share ("Chart" and "Chart") says nothing about how their arrangements
 * differ, so the shared key is demoted to the description and then to the
 * derived rotation: three identical compositions in one comparison is the one
 * outcome the judged question cannot survive.
 */
export function compositionFor(option, siblings = []) {
  const key = treatmentKey(option);
  const description = String(option?.description ?? "").trim();
  const table = TREATMENT_FAMILIES[key];
  const sharedKey = Boolean(table) && siblings.some((sibling) => treatmentKey(sibling) === key);
  if (table && !sharedKey) return { family: table, source: "table", key };
  for (const [pattern, family] of DESCRIPTION_CUES) {
    if (pattern.test(description)) return { family, source: "description", key };
  }
  if (description) {
    const family = ROTATION[hash32(description) % ROTATION.length];
    return { family, source: "derived", key };
  }
  return { family: table ?? "single", source: table ? "table" : "default", key };
}

/**
 * The countable drawing instruction for one option.
 *
 * The sentence is built from the family rather than hand-written per treatment
 * so every prompt in the corpus is expressed in the same display budget: at
 * most nine large shapes, thick outlines, no type.
 */
export function compositionSentence(option, siblings = []) {
  const { family, source, key } = compositionFor(option, siblings);
  const spec = FAMILIES[family] ?? FAMILIES.single;
  const label = source === "table"
    ? `The arrangement is "${key}"`
    : source === "description"
      ? "The arrangement follows the treatment's own description"
      : source === "derived"
        ? "The treatment names no arrangement of its own, so the layout is chosen from its own wording"
        : "The arrangement is not named by the treatment, so it is drawn as a plain balanced composition";
  return {
    family,
    source,
    key,
    blocks: spec.blocks,
    sentence: `${label}: ${spec.draw}. ${spec.content}.`,
  };
}

/**
 * The style clause every prompt carries.
 *
 * It quotes the display budget the prompt is written against, and it is the
 * direct inverse of the style that measured at 34.5% severe: no hairlines, no
 * fine type, no "fill the frame", and a hard ceiling on how many shapes may
 * appear. Wide white gaps are requested explicitly because a gap is the only
 * thing that keeps neighbouring shapes separate after a 3.7x reduction.
 */
export const DISPLAY_STYLE = Object.freeze([
  `Draw for the size it will be shown at: this image is displayed at about ${TERMINAL_DISPLAY.pixelWidth} by ${TERMINAL_DISPLAY.pixelHeight} pixels, smaller than a postage stamp, so it has to be read as shape and colour rather than as detail.`,
  "Flat vector shapes on a pure white background, seen straight on, filling the whole frame: solid fills only, thick black outlines at least 12 pixels wide, no thin lines, no hairlines, no grey tints, no gradients, no shadows, no 3D, no perspective, no device frame, no texture, no photography.",
  "At most nine shapes in the whole image, and every one of them at least a fifth of the frame across. Leave wide white gaps between neighbouring shapes so each keeps its own outline when the image is shrunk.",
  "Use three flat colours at most: black, white, and one bold accent colour.",
  "No text of any kind: no letters, no words, no numbers, no captions, no labels, no logos, no placeholders, no watermarks.",
  "Every shape is a plain block or a simple disc, triangle or bar with straight edges, and each one is recognisable from its silhouette alone.",
].join(" "));

/** The negative prompt sent alongside every generation. */
export const DISPLAY_NEGATIVE_PROMPT = Object.freeze([
  "text, letters, words, numbers, captions, labels, logos, watermarks, signature",
  "thin lines, hairlines, fine detail, small icons, tiny text, dense grids, clutter, many small elements",
  "gradients, drop shadows, 3d rendering, isometric view, perspective, photo texture, noise",
  "device bezel, browser chrome, hands, people, poster layout, marketing copy",
].join(", "));
