#!/usr/bin/env node
/**
 * The live smoke's session plan, as data.
 *
 * SMOKE-001: the real-TTY run proved one happy path - inline image, keyboard,
 * stage advance, Ctrl+] collapse/reopen, a custom answer, the external editor,
 * the final review - and never a note, a revision, a reject or a cancel. Rather
 * than grow that single walk, the walk is split into five real PTY sessions,
 * one per review, and every part of the plan lives here:
 *
 *  - which review each session opens,
 *  - which step it records in its evidence,
 *  - the one named assertion it contributes to `.pi/benchmark/live-smoke.json`,
 *  - the pure check that turns that session's evidence into that assertion.
 *
 * The driver, the smoke gate and the regression suite all read this list, so a
 * behaviour cannot be dropped from the live run without the aggregate losing a
 * named assertion and the suite failing. Reject and cancel end a review, so
 * each gets its own session rather than being two stops on one walk.
 */
import { BenchmarkError } from "./common.mjs";

export const HAPPY_SESSION = "happy";

/** The four behaviours SMOKE-001 named, in the order they are driven. */
export const BEHAVIOUR_SESSIONS = Object.freeze(["note", "revision", "reject", "cancel"]);

/** Every session the smoke runs, happy path first. */
export const SESSION_MODES = Object.freeze([HAPPY_SESSION, ...BEHAVIOUR_SESSIONS]);

/** The text the note session types and the revision session submits. */
export const NOTE_TEXT = "keep the generous spacing";
export const REVISION_FEEDBACK = "make the dense option less cramped";

/** Labels the driver navigates to, read from the rendered screen - never guessed indices. */
export const LABELS = Object.freeze({
  approve: "Approve review",
  reject: "Reject review",
  revision: "Request revision",
  reviewTab: "Review your answers",
  notePrompt: "Add a note for this stage:",
  revisionPrompt: "Describe the revision you want:",
});

/** The happy path's own review, unchanged from the walk SMOKE-001 already proved. */
function happyReview(imagePath) {
  return {
    reviewId: "live-smoke",
  // The live smoke exists to prove the image path, so it asks for pictures; a
  // real review gets the default, which is structure only.
  images: "on",
    title: "Live TTY smoke",
    stages: [
      {
        id: "direction", kind: "draft", header: "Direction", prompt: "Pick the visual treatment",
        options: [
          { id: "airy", label: "Airy treatment", description: "Open layout with generous spacing", image: { path: imagePath, alt: "Generated treatment" } },
          { id: "dense", label: "Dense treatment", description: "Compact layout" },
        ],
      },
      {
        id: "followup", kind: "choice", header: "Follow-up", prompt: "Capture anything else", required: false,
        options: [{ id: "none", label: "Nothing else" }, { id: "blocked", label: "Blocked on review" }],
      },
    ],
  };
}

/**
 * The note session keeps the real generated image on its first option, so the
 * note is attached to an answer made against a genuinely rendered preview. The
 * revision, reject and cancel sessions are text-only: what they prove is the
 * decision path, and a second full-resolution image render per session would
 * cost PTY throughput and prove nothing they are not already proving.
 */
function noteReview(imagePath) {
  return {
    reviewId: "live-smoke-note",
    title: "Live TTY smoke (note)",
    round: 1,
    // Pictures are off by default; the smoke opts in, because the note session
    // asserts against a frame that carries one.
    images: "on",
    stages: [
      {
        id: "direction", kind: "draft", header: "Direction", prompt: "Pick the visual treatment",
        options: [
          { id: "airy", label: "Airy treatment", description: "Open layout with generous spacing", image: { path: imagePath, alt: "Generated treatment" } },
          { id: "dense", label: "Dense treatment", description: "Compact layout" },
        ],
      },
    ],
  };
}

function singleStageReview({ mode, prompt, header, options, allowRevision = true }) {
  return {
    reviewId: `live-smoke-${mode}`,
    title: `Live TTY smoke (${mode})`,
    round: 1,
    stages: [{ id: "decision", kind: "draft", header, prompt, allowRevision, allowOther: false, options }],
  };
}

/**
 * The plan for one session. `step` is the name the driver records, `assertion`
 * the name the aggregate records, and `expect` the sentence a reader can check
 * the evidence against.
 */
export function sessionPlan(mode, { imagePath = "" } = {}) {
  if (!SESSION_MODES.includes(mode)) {
    throw new BenchmarkError("unknown_session", `Unknown live session "${mode}"; expected one of ${SESSION_MODES.join(", ")}.`);
  }
  if (mode === HAPPY_SESSION) {
    return {
      mode,
      step: "complete",
      assertion: null,
      title: "Live TTY smoke",
      imageOption: { stageId: "direction", optionId: "airy" },
      answer: "Dense treatment",
      expect: "the eleven happy-path assertions, unchanged",
      review: happyReview(imagePath),
    };
  }
  if (mode === "note") {
    return {
      mode,
      step: "note",
      assertion: "note",
      title: "Live TTY smoke (note)",
      imageOption: { stageId: "direction", optionId: "airy" },
      answer: "Airy treatment",
      expect: `a note typed against the answered stage, visible on screen and carried back as answers[].notes ("${NOTE_TEXT}")`,
      review: noteReview(imagePath),
    };
  }
  if (mode === "revision") {
    return {
      mode,
      step: "revision",
      assertion: "revision",
      title: "Live TTY smoke (revision)",
      imageOption: null,
      expect: `a revision requested on the PTY ("${REVISION_FEEDBACK}"), returned to the model as a revision result asking for round 2, and round 2 then approved`,
      review: singleStageReview({
        mode,
        header: "Layout",
        prompt: "Pick the layout direction",
        options: [
          { id: "grid", label: "Grid layout", description: "Three equal columns" },
          { id: "stack", label: "Stacked layout", description: "One column, tall rows" },
        ],
      }),
    };
  }
  if (mode === "reject") {
    return {
      mode,
      step: "reject",
      assertion: "reject",
      title: "Live TTY smoke (reject)",
      imageOption: null,
      answer: "Short headline",
      expect: "the review answered and then rejected from the final review, ending the review as rejected",
      review: singleStageReview({
        mode,
        header: "Copy",
        prompt: "Pick the headline",
        options: [
          { id: "short", label: "Short headline", description: "Three words" },
          { id: "long", label: "Long headline", description: "A full sentence" },
        ],
      }),
    };
  }
  return {
    mode: "cancel",
    step: "cancel",
    assertion: "cancel",
    title: "Live TTY smoke (cancel)",
    imageOption: null,
    expect: "Escape pressed on a real terminal mid-review, ending the review as an explicit cancellation",
    review: singleStageReview({
      mode,
      header: "Accent",
      prompt: "Pick the accent colour",
      options: [
        { id: "teal", label: "Teal accent", description: "Cool accent" },
        { id: "amber", label: "Amber accent", description: "Warm accent" },
      ],
    }),
  };
}

/**
 * Turn one session's evidence into its one assertion.
 *
 * The check is deliberately mechanical and side-effect free: it reads only what
 * the driver recorded, so the regression suite can pin it with a fixture while
 * the live run proves the same check against real keypresses. A session passes
 * only when its own step, its own result and the behaviour it names all agree.
 */
export function verifySessionEvidence(plan, evidence) {
  const reasons = [];
  const step = (evidence?.steps ?? []).find((entry) => entry.step === plan.step) ?? null;
  if (!step) reasons.push(`no "${plan.step}" step was recorded`);
  const result = evidence?.session?.result ?? null;
  if (!result) reasons.push("the session recorded no tool result");
  const status = result?.status ?? null;
  const decision = result?.decision ?? null;
  if (plan.mode === HAPPY_SESSION) {
    const assertions = evidence?.assertions ?? {};
    if (Object.keys(assertions).length === 0) reasons.push("the happy path recorded no assertions");
    for (const [name, value] of Object.entries(assertions)) {
      if (value !== true) reasons.push(`happy-path assertion ${name} is ${JSON.stringify(value)}`);
    }
    return { passed: reasons.length === 0, reasons };
  }
  if (plan.mode === "note") {
    if (status !== "completed") reasons.push(`the review ended as ${status ?? "nothing"} instead of completed`);
    if (step?.text !== NOTE_TEXT) reasons.push(`the recorded note is ${JSON.stringify(step?.text ?? null)}`);
    if (step?.attached !== true) reasons.push("the note never reached the on-screen answer line");
    const noted = (result?.answers ?? []).some((answer) => answer?.notes === NOTE_TEXT);
    if (!noted) reasons.push(`no answer carried the note back from the tool: ${JSON.stringify(result?.answers ?? [])}`);
  } else if (plan.mode === "revision") {
    const rounds = evidence?.session?.rounds ?? [];
    const first = rounds[0] ?? null;
    const second = rounds[1] ?? null;
    if (first?.status !== "revision") reasons.push(`round 1 ended as ${first?.status ?? "nothing"} instead of revision`);
    if (first?.decision !== "revision") reasons.push(`round 1 returned the decision ${JSON.stringify(first?.decision ?? null)}`);
    if (first?.revision?.feedback !== REVISION_FEEDBACK) reasons.push(`round 1 carried the feedback ${JSON.stringify(first?.revision?.feedback ?? null)}`);
    if (first?.revision?.requestedRound !== 2) reasons.push(`round 1 asked for round ${first?.revision?.requestedRound ?? "none"} instead of 2`);
    if (step?.feedback !== REVISION_FEEDBACK) reasons.push(`the recorded revision feedback is ${JSON.stringify(step?.feedback ?? null)}`);
    if (!second) reasons.push("no second round ran after the revision request");
    else if (second.round !== 2) reasons.push(`the second round ran as round ${second.round}`);
    else if (second.status !== "completed") reasons.push(`the second round ended as ${second.status} instead of completed`);
  } else if (plan.mode === "reject") {
    if (status !== "rejected") reasons.push(`the review ended as ${status ?? "nothing"} instead of rejected`);
    if (decision !== "reject") reasons.push(`the review returned the decision ${JSON.stringify(decision)}`);
    if (!step?.endedBy) reasons.push("the reject step recorded no ending action");
  } else {
    if (status !== "cancelled") reasons.push(`the review ended as ${status ?? "nothing"} instead of cancelled`);
    if (decision !== "cancel") reasons.push(`the review returned the decision ${JSON.stringify(decision)}`);
    if (result?.cancelled !== true) reasons.push(`the review reported cancelled=${JSON.stringify(result?.cancelled ?? null)}`);
    if (!step?.endedBy) reasons.push("the cancel step recorded no ending key");
  }
  return { passed: reasons.length === 0, reasons };
}

/**
 * Fold every session's evidence into the single record the gate publishes.
 *
 * A session that did not run is a failure, not an absence: the aggregate only
 * passes when all five sessions ran and each of the four named behaviours
 * produced its assertion from its own evidence.
 */
export function aggregateSessionEvidence(entries) {
  const sessions = [];
  const assertions = {};
  const steps = [];
  const errors = {};
  for (const entry of entries) {
    const plan = entry.plan;
    const evidence = entry.evidence ?? {};
    const verified = verifySessionEvidence(plan, evidence);
    sessions.push({
      session: plan.mode,
      title: plan.title,
      step: plan.step,
      expect: plan.expect,
      status: evidence.status ?? "failed",
      steps: evidence.steps?.length ?? 0,
      passed: verified.passed,
      reasons: verified.reasons,
    });
    for (const step of evidence.steps ?? []) steps.push({ session: plan.mode, ...step });
    for (const [name, message] of Object.entries(evidence.errors ?? {})) errors[`${plan.mode}:${name}`] = message;
    if (plan.assertion) assertions[plan.assertion] = verified.passed;
    else Object.assign(assertions, evidence.assertions ?? {});
  }
  const ran = new Set(sessions.map((session) => session.session));
  const missing = SESSION_MODES.filter((mode) => !ran.has(mode));
  const unproven = BEHAVIOUR_SESSIONS.filter((mode) => {
    const found = sessions.find((session) => session.session === mode);
    return !found || found.passed !== true;
  });
  const status = sessions.every((session) => session.passed) && missing.length === 0 ? "passed" : "failed";
  return { status, assertions, steps, sessions, errors, missingSessions: missing, unprovenBehaviours: unproven };
}
