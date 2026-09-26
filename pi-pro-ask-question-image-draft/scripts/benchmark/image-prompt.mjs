/**
 * Decision-useful image prompts for the visual stratum.
 *
 * Two prompt revisions are recorded here, because both failures were real and
 * the second one was expensive.
 *
 * The first prompt asked the image model for "only shapes, blocks, bars, lines,
 * and colour" and forbade text outright. The visual stratum is a set of
 * *interface arrangement* decisions (nav rail vs tabs vs bottom sheet, inline
 * notice vs toast vs modal, airy vs split vs dense, wide vs paired vs exact).
 * Stripping the surface out of the prompt produced content-free rectangles, so
 * the images carried no decision information and the blinded win rate collapsed
 * to chance.
 *
 * The second prompt named the surface and the treatment and asked for a full
 * flat-vector interface mockup with "thin dark outlines" and "fill the frame:
 * every region contains interface elements". That reads like an improvement and
 * measured like a regression: the judge sees the image on the 31 x 16 cell grid
 * the terminal actually displays, which is about 279 x 279 pixels, and a
 * full-density mockup reduced 3.7x is texture. 34.5% of candidate cases were
 * charged as severe failures, two thirds of them because the three treatments
 * of a scenario turned into three shades of the same grey grid.
 *
 * The prompt is therefore written in the units the display can resolve. The
 * treatment resolves to a countable composition through
 * `scripts/benchmark/composition.mjs` - two panels, three stacked blocks, a
 * three-by-three grid - and the style spends its whole budget on a handful of
 * large solid shapes, thick outlines and wide white gaps. The subject is still
 * named, so the image still depicts the surface the decision is about, and
 * derivation stays deterministic and table-driven so a prompt remains a pure
 * function of the scenario: that is what keeps the prompt-hash cache, and with
 * it the 600-image budget, reproducible.
 */

import {
  compositionFor,
  compositionSentence,
  DISPLAY_NEGATIVE_PROMPT,
  DISPLAY_STYLE,
  domainMarks,
  treatmentKey,
} from "./composition.mjs";

export { DISPLAY_NEGATIVE_PROMPT, DISPLAY_STYLE, treatmentKey };

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
/**
 * Concrete, drawable instruction for one treatment.
 *
 * The directive is the treatment's countable composition, so every prompt in the
 * corpus is expressed in the same display budget: at most nine large shapes,
 * thick outlines, no type. A treatment the vocabulary does not name falls back
 * to its own description and then to a stable rotation, never to a bare name.
 */
export function treatmentDirective(option, siblings = []) {
  const composition = compositionFor(option, siblings);
  const { sentence } = compositionSentence(option, siblings);
  return { directive: sentence, source: composition.source, family: composition.family, blocks: compositionSentence(option, siblings).blocks };
}

/**
 * Prompt for one option's image. Deterministic: the same scenario and option
 * always produce the same string, which is what the prompt-hash cache relies on.
 *
 * `siblings` are the stage's other options. They are passed so two options that
 * share a treatment word cannot collapse onto one identical composition.
 */
export function optionPrompt(scenario, option, { siblings } = {}) {
  const concept = String(scenario?.visualPrompt?.prompt ?? "").trim();
  if (!concept) throw new Error(`${scenario?.id} has no visual prompt.`);
  const { subject } = surfaceSubject(scenario);
  const marks = domainMarks(titleOf(scenario));
  const others = siblings ?? (scenario?.canonicalInput?.stages ?? [])
    .flatMap((stage) => stage.options ?? [])
    .filter((candidate) => candidate !== option);
  const composition = compositionSentence(option, others);
  const description = String(option?.description ?? "").trim();
  // The option's own name is deliberately absent: the judged comparison is
  // blinded, and a model that captions its image with the option label would
  // leak the treatment identity straight into the judge's view.
  return [
    `Draw exactly this composition and nothing else: ${composition.sentence}`,
    `The screen is about ${subject}.`,
    `Place two or three oversized, clearly recognisable pictograms from that subject inside it: ${marks.join(", ")}. They must read as ${subject} at postage-stamp size, drawn as plain bold shapes with no detail inside them. Add one thick reference line, axis or scale bar that shows the quantity being compared.`,
    description ? `This treatment exists to: ${description}` : "",
    `It must support this decision: ${concept}`,
    `The three candidate treatments differ only in arrangement, so the arrangement above must be unmistakable from the shapes alone.`,
    DISPLAY_STYLE,
  ].filter(Boolean).join(" ");
}

/** The negative prompt every generation carries; see `composition.mjs`. */
export function optionNegativePrompt() {
  return DISPLAY_NEGATIVE_PROMPT;
}
