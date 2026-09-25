/**
 * Decision-useful image prompts for the visual stratum.
 *
 * Root cause this module exists to fix: the first prompt asked the image model
 * for "only shapes, blocks, bars, lines, and colour" and forbade text outright.
 * The visual stratum is a set of *interface arrangement* decisions (nav rail vs
 * tabs vs bottom sheet, inline notice vs toast vs modal, airy vs split vs
 * dense, wide vs paired vs exact). Stripping the surface out of the prompt
 * produced content-free rectangles, so the images carried no decision
 * information and the blinded win rate collapsed to chance.
 *
 * The fix is to name the surface and the treatment explicitly and let the model
 * draw the actual mockup. Derivation is deterministic and table-driven so a
 * prompt is a pure function of the scenario, which keeps the prompt-hash cache
 * (and therefore the 600-image budget) reproducible.
 */

/** Treatment vocabulary -> concrete, drawable instruction. */
export const TREATMENT_DIRECTIVES = Object.freeze({
  // Density / focus
  airy: "one single wide column with very generous spacing, few elements, and one obvious focal element",
  spacious: "one single wide column with very generous spacing, few elements, and one obvious focal element",
  minimal: "one single wide column with very generous spacing, few elements, and one obvious focal element",
  simple: "one single wide column with very generous spacing, few elements, and one obvious focal element",
  compact: "a compact block that keeps everything in one small footprint with tight but even spacing",
  focused: "one dominant element with everything else pushed to the edges",
  overview: "everything visible at once in a single flat summary of the whole screen",
  context: "a primary element with a smaller always-visible supporting panel beside it",
  hero: "one large full-width panel with the remaining elements small and subordinate",
  glance: "three or four large, unmistakable blocks that read in a single glance",

  // Structure
  split: "two clearly separated panes side by side, each with its own border and its own heading row",
  paired: "two clearly separated panels side by side that mirror the same data",
  columns: "three or four equal vertical columns side by side",
  multi: "several equal panels arranged side by side",
  layered: "stacked layers that visibly overlap, back layer dimmed behind the front layer",
  stages: "a left-to-right sequence of discrete stage blocks joined by arrows",
  steps: "a left-to-right sequence of numbered step blocks joined by arrows",
  linear: "a single straight left-to-right sequence of blocks joined by arrows",
  staged: "a left-to-right sequence of stage blocks joined by arrows",
  flow: "rectangular process boxes connected by directional arrows",
  pipeline: "rectangular process boxes connected left to right by arrows, each box the same width",
  tree: "a parent node at the top branching downward into child nodes",
  nested: "boxes nested inside boxes, each level visibly inset",
  phased: "three labelled phase bands stacked vertically, each band wider than the one above it",
  progressive: "a single column that reveals progressively more detail lower down",

  // Density (opposite end)
  dense: "a tightly packed grid of many small panels and rows filling the whole frame, no wasted space",
  detail: "a tightly packed grid of many small panels and rows filling the whole frame",
  complete: "a tightly packed grid of many small panels and rows filling the whole frame",
  grid: "a regular grid of many equal small cells filling the whole frame",
  matrix: "a regular grid of many equal small cells, some filled dark and some empty",
  cells: "a regular grid of many equal small cells, some filled dark and some empty",
  rows: "many horizontal rows of small repeated blocks stacked tightly",
  table: "a dense table: a header row plus many tightly packed data rows with column separators",
  checklist: "a vertical list of many short rows, each with a small square checkbox on the left",
  exact: "a dense table of exact numeric values in aligned columns, digits evenly spaced",
  pairedexact: "two dense tables of exact numeric values side by side",
  stacked: "bars stacked on top of each other in a few thick segments",
  cards: "a grid of rectangular cards, each with an image area on top and a text area below",
  tiles: "a grid of square tiles, each with an image area on top and a text area below",
  stepsnumbered: "a vertical list of numbered steps, each step a row with a circled number",

  // Placement / pattern
  rail: "a persistent vertical navigation rail pinned to the left edge with stacked icons",
  tabs: "a horizontal tab bar pinned to the top or bottom edge with equal-width tabs",
  sheet: "a panel sliding up from the bottom edge covering the lower half of the screen",
  overlay: "a translucent panel floating above the content with a dimmed backdrop",
  inline: "a notice placed directly inside the content next to the field it refers to",
  toast: "a small floating rounded notice in the top corner overlaying the content",
  dialog: "a centered modal card with a dimmed backdrop and two buttons at the bottom",
  banner: "one full-width horizontal band across the top of the screen",
  strip: "one thin full-width horizontal strip across the screen",
  hero2: "one large full-width block at the top with supporting blocks below",
  accordion: "stacked collapsible rows, each row a header bar with a small chevron on the right",
  search: "a search field at the top with a magnifier icon and a short result list below",
  wizard: "a linear stepper across the top with one active step highlighted",
  breadcrumb: "a single row of small chevron-separated crumbs at the top of the screen",
  pagination: "a row of small numbered page buttons centred at the bottom",
  drawer: "a panel sliding in from the side edge, half the screen width",
  sidebar: "a left sidebar with a vertical list of items and a highlighted active row",
  heroimage: "a large photographic or illustrated area filling the top two thirds of the screen",

  // Mobile-specific
  shelf: "three small icons in a row above a thumb-reachable bottom bar",
  thumb: "controls grouped in the lower corners where a thumb can reach them",
  swipe: "a horizontally swipeable card deck showing one card at a time with peeking edges",
  carousel: "a horizontally swipeable card deck showing one card at a time with peeking edges",

  // Content emphasis
  hero3: "one large dominant element with everything else small",
  narrative: "a vertical story of alternating image and text blocks, scrolled top to bottom",
  story: "a vertical story of alternating image and text blocks, scrolled top to bottom",
  explained: "a diagram with a short caption block and a legend keyed to numbered callouts",
  legend: "a chart with a separate legend block listing colour swatches",
  editorial: "a magazine layout with a large headline block, a wide image band, and columns of text",
  wayfinding: "a floor-plan style map with thick paths, a start marker, and a destination marker",
  artwork: "a large decorative illustration filling most of the frame",
  illustration: "a large decorative illustration filling most of the frame",
  portrait: "a tall portrait-oriented panel centred with margins on both sides",
  friendly: "rounded corners, soft shapes, and a welcoming empty-state block with one prominent button",
  duotone: "two colours only, high contrast, one for background and one for all marks",
  icon: "a row of simple single-colour icons, each in its own square cell",
  icons: "a row of simple single-colour icons, each in its own square cell",
  badges: "small rounded pill badges attached to the right edge of each row",
  scores: "each row ending in a small numeric score block and a short bar",
  highlight: "one element brightly highlighted while the rest are muted grey",
  zoom: "a magnified inset panel connected to a region of the main view by two guide lines",
  filter: "a row of filter chips under a header, one chip visibly active",
  breadcrumb2: "a single row of small chevron-separated crumbs at the top",
  group: "related rows visually enclosed together inside one bordered group",
  ranked: "rows ordered top to bottom with a leading position number block",
  priority: "rows sorted into two or three lanes by urgency, each lane with its own colour",
  lanes: "rows sorted into two or three lanes by urgency, each lane with its own colour",
  swimlane: "horizontal lanes with blocks placed inside each lane by stage",
  queue: "a vertical queue of items with the front item pulled out and highlighted",
  route: "a path from a start marker to a destination marker with waypoint dots along it",
  path: "a path from a start marker to a destination marker with waypoint dots along it",
  map: "a region map with filled areas, a boundary outline, and two location markers",
  geographic: "a region map with filled areas, a boundary outline, and two location markers",
  mesh: "a node-link graph with nodes at different sizes joined by thin edges",
  network: "a node-link graph with nodes at different sizes joined by thin edges",
  topology: "a node-link graph with nodes at different sizes joined by thin edges",
  graph: "a node-link graph with nodes at different sizes joined by thin edges",
  hub: "one large central node joined to many smaller satellite nodes",
  sankey: "thick curved ribbons flowing from a left column of nodes to a right column of nodes",
  treemap: "nested rectangles of different sizes tiling the frame, largest first",
  gantt: "horizontal time bars in rows against a date axis, different start and length",
  timeline: "a vertical spine with dots and side cards marking events in order",
  sequence: "blocks connected left to right by arrows, each block containing two stacked lines",
  state: "circles connected by arrows, one circle filled to mark the current state",
  machine: "circles connected by arrows, one circle filled to mark the current state",
  cycle: "a ring of blocks connected in a circle by arrows",
  loop: "a ring of blocks connected in a circle by arrows",
  diff: "two columns side by side, additions in green and removals in red, line by line",
  summary: "a compact scorecard: a row of large numbers each under a small caption block",
  scorecard: "a compact scorecard: a row of large numbers each under a small caption block",
  digest: "a single column of grouped message blocks with small unread dots",
  thread: "nested conversation blocks indented progressively to the right",
  queue2: "a vertical list of items each with a leading status dot",
  panel: "one dominant panel with a small secondary panel docked below it",
  pages: "two page thumbnails side by side with the active one larger",
  sheet2: "a panel sliding up from the bottom edge covering the lower half of the screen",
  accordion2: "stacked collapsible rows, each row a header bar with a small chevron on the right",

  // Chart forms
  bars: "vertical bars of differing heights on a shared baseline with a faint grid",
  bar: "vertical bars of differing heights on a shared baseline with a faint grid",
  multiples: "small multiples: a grid of identically scaled mini charts, one per series",
  line: "a line chart with several coloured lines and faint gridlines",
  lines: "a line chart with several coloured lines and faint gridlines",
  curve: "a line chart with smooth crossing curves and faint gridlines",
  curves: "a line chart with smooth crossing curves and faint gridlines",
  trend: "a line chart trending over time with a marked data point and faint gridlines",
  sparkline: "a row of tiny sparklines, one per table row",
  scatter: "a scatter plot of separated dots, a few of them circled",
  bubbles: "a bubble chart of circles of clearly different sizes",
  radar: "a radar chart with a filled polygon over faint spokes",
  heatmap: "a grid heatmap whose cells run from pale to saturated colour",
  heat: "a grid heatmap whose cells run from pale to saturated colour",
  histogram: "adjacent bars forming a bell-shaped distribution",
  distribution: "adjacent bars forming a distribution with a long tail",
  bands: "stacked horizontal bands showing composition over time",
  range: "a dumbbell chart with a bar spanning a low and a high value per row",
  waterfall: "a waterfall of rising and falling blocks joined end to end",
  funnel: "a funnel of progressively narrower horizontal blocks",
  pyramid: "a triangle of stacked rows narrowing toward the top",
  rings: "concentric donut rings of decreasing thickness",
  gauge: "a row of circular gauges with needles at different angles",
  band: "a line chart with a wide shaded uncertainty band around it",
  bins: "a histogram of adjacent bars in clearly different colours",
  plot: "a scatter plot with axes, a trend line, and faint gridlines",
  diverging: "a diverging stacked bar chart centred on a zero axis",
  interval: "horizontal interval bars per row with visible low and high caps",
  points: "a scatter plot of separated dots, a few of them circled",
  zone: "a map-like area split into colour zones with a legend",
  zones: "a map-like area split into colour zones with a legend",
  tiles2: "a grid of square tiles, each with an image area on top and a text area below",
  quad: "a four-quadrant scatter with a faint cross through the middle",
  streak: "a grid of small cells forming diagonal streaks over a faint grid",
  portlet: "a grid of rectangular portlet panels, each with its own header bar",
  hex: "a honeycomb of hexagonal cells",
  ribbon: "stacked ribbon bands flowing across the frame",
  layers2: "stacked layers that visibly overlap, back layer dimmed behind the front layer",
});

const TITLE_SUBJECTS = [
  [/heatmap/i, "a grid heatmap"],
  [/histogram/i, "a histogram"],
  [/retention curves|curves/i, "a multi-series line chart with crossing curves"],
  [/gauge/i, "a row of circular gauges"],
  [/forecast|uncertainty band/i, "a line chart with a wide shaded uncertainty band around it"],
  [/waterfall/i, "a waterfall chart"],
  [/sankey/i, "a sankey flow diagram"],
  [/treemap/i, "a treemap"],
  [/scatter/i, "a scatter plot"],
  [/bubbles/i, "a bubble chart"],
  [/radar/i, "a radar chart"],
  [/pyramid/i, "a funnel chart"],
  [/rings/i, "concentric donut rings"],
  [/chromosome|genomic|locus/i, "a genome browser track view with coloured banded arcs"],
  [/basin/i, "a catchment basin map with filled regions"],
  [/mesh/i, "a node-link network diagram"],
  [/network|topology/i, "a node-link network diagram"],
  [/decision tree|tree/i, "a node-link tree diagram"],
  [/state machine/i, "circles connected by arrows with one filled as the current state"],
  [/sequence|sync/i, "blocks connected left to right by arrows"],
  [/pipeline/i, "a left-to-right pipeline of process blocks"],
  [/flow|pacing/i, "a flowchart of process boxes connected by arrows"],
  [/swimlane|lane/i, "horizontal swimlanes with blocks placed inside each lane"],
  [/gantt/i, "a gantt chart of horizontal time bars"],
  [/timeline/i, "a vertical timeline with events in order"],
  [/cycle|loop/i, "a ring of blocks connected in a circle"],
  [/map/i, "a region map with filled areas and location markers"],
  [/spread|distribution/i, "a distribution plot"],
  [/mix|composition/i, "a stacked composition chart"],
  [/trend/i, "a line chart trending over time"],
  [/comparison|compare/i, "a side-by-side comparison chart"],
  [/density|gradient/i, "a filled contour or density plot"],
  [/range|interval/i, "a chart of horizontal interval bars"],
  [/scorecard|oee|summary/i, "a scorecard of large labelled numbers and gauges"],
  [/ranking|rank/i, "a ranked bar list"],
  [/progress/i, "a progress board of status columns"],
];

/** Fallback screen subjects, matched on the scenario title. */
const TITLE_FALLBACKS = [
  [/mobile|thumb/i, "a mobile phone screen"],
  [/toast|dialog|banner|strip|overlay/i, "an application screen showing a notification pattern"],
  [/onboarding|empty state|first project|wizard/i, "an application screen in a first-run or empty state"],
  [/settings|search|preference/i, "an application settings screen"],
  [/checkout|cart|order/i, "a checkout screen with an order summary"],
  [/inbox|notification|alert|queue|triage/i, "an operations screen with a work queue"],
  [/dash|board|console|desk|view|screen|panel/i, "a desktop application screen"],
];

function titleOf(scenario) {
  return String(scenario?.canonicalInput?.title ?? "").trim();
}

/** The concrete surface the image must depict, derived from the scenario title. */
export function surfaceSubject(scenario) {
  const title = titleOf(scenario);
  for (const [pattern, subject] of TITLE_SUBJECTS) {
    if (pattern.test(title)) return { kind: "chart", subject };
  }
  for (const [pattern, subject] of TITLE_FALLBACKS) {
    if (pattern.test(title)) return { kind: "screen", subject };
  }
  return { kind: "screen", subject: title ? `an application screen for ${title.toLowerCase()}` : "an application screen" };
}

/** The last meaningful word of the option label names the treatment. */
export function treatmentKey(option) {
  const label = String(option?.label ?? "").trim();
  const words = label.split(/[\s-]+/).filter(Boolean);
  const last = (words.at(-1) ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return last;
}

/** Concrete, drawable instruction for one treatment. */
export function treatmentDirective(option) {
  const label = String(option?.label ?? "").trim();
  const key = treatmentKey(option);
  const known = TREATMENT_DIRECTIVES[key];
  if (known) return { directive: known, source: "table" };
  const description = String(option?.description ?? "").trim();
  const text = description || `the ${label} treatment`;
  return { directive: `the "${text}" treatment`, source: "description" };
}

const STYLE = [
  "Style: clean flat vector wireframe, straight-on orthographic view filling the whole frame, plain white background, thin dark outlines, one accent colour plus status colours, no gradients, no 3D, no drop shadows, no perspective, no device bezel, no hands, no photography, no watermark, no poster headline, no marketing copy.",
  "Fill the frame: every region contains interface elements such as rows, panels, cells, bars or buttons, top to bottom and edge to edge. No large blank areas and no empty panel bodies.",
  "Never write the name of this option, the product name, or any title or caption text anywhere in the image.",
  "Legibility: strong contrast, one obvious focal point, and structure that survives being scaled down to 40x20 terminal characters.",
  "Short neutral placeholder words may appear inside the interface chrome only; the layout, grouping, colour and emphasis are what must read at a glance.",
].join(" ");

/**
 * Prompt for one option's image. Deterministic: the same scenario and option
 * always produce the same string, which is what the prompt-hash cache relies on.
 */
export function optionPrompt(scenario, option) {
  const concept = String(scenario?.visualPrompt?.prompt ?? "").trim();
  if (!concept) throw new Error(`${scenario?.id} has no visual prompt.`);
  const { subject } = surfaceSubject(scenario);
  const { directive, source } = treatmentDirective(option);
  const description = String(option?.description ?? "").trim();
  // The option's own name is deliberately absent: the judged comparison is
  // blinded, and a model that captions its image with the option label would
  // leak the treatment identity straight into the judge's view.
  return [
    `A single ${subject} drawn as a flat UI mockup, straight-on, filling the whole frame.`,
    `In this screen the layout is: ${directive}.`,
    description ? `Design intent behind this layout: ${description}` : "",
    `It must support this decision: ${concept}`,
    "The three candidate treatments for this decision differ only in arrangement, so the arrangement must be unmistakable.",
    STYLE,
    source === "description" ? "Treat the quoted description as the layout to draw." : "",
  ].filter(Boolean).join(" ");
}
