#!/usr/bin/env node
import { resolve } from "node:path";

import { normalizeReview, RESERVED_LABELS } from "../../src/schema.ts";
import {
  assertNoCredentials,
  BenchmarkError,
  parseArgs,
  parseCount,
  parseSeed,
  requireRecord,
  requireString,
  SCHEMA_VERSION,
  stableStringify,
  writeJson,
} from "./common.mjs";

export const STRATA = Object.freeze(["ordinary", "visual", "adversarial"]);
export const TERMINAL_STATUSES = Object.freeze(new Set(["completed", "rejected", "cancelled", "revision", "fallback", "invalid"]));
const ALL_RESERVED = new Set([...RESERVED_LABELS, "Other", "Next", "Edit answers", "Review & approve"]);

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function allocateStrata(count) {
  const visual = Math.round(count * 0.2);
  const adversarial = Math.round(count * 0.1);
  return { ordinary: count - visual - adversarial, visual, adversarial };
}

function labelFor(stratum, index, variant) {
  return `${stratum === "ordinary" ? "Path" : stratum === "visual" ? "Canvas" : "Boundary"} ${String(index).padStart(4, "0")} ${variant}`;
}

function answerFor(kind, labels, customText) {
  if (kind === "multi") return { kind, selected: [...labels] };
  if (kind === "custom") return { kind, answer: customText };
  return { kind, answer: labels[0] };
}

function ordinaryScenario(id, index, variant, seed) {
  const questionCount = 1 + (index % 4);
  const multi = index % 5 === 0;
  const custom = !multi && index % 7 === 0;
  const questions = Array.from({ length: questionCount }, (_, questionIndex) => {
    const optionCount = 2 + ((index + questionIndex) % 3);
    const options = Array.from({ length: optionCount }, (_, optionIndex) => {
      const choice = labelFor("ordinary", index + questionIndex * 17, ["compact", "balanced", "expanded"][optionIndex]);
      return { label: choice, description: `Deterministic compatibility choice ${questionIndex + 1}.${optionIndex + 1}; seed ${seed}.` };
    });
    const kind = multi ? "multi" : custom ? "custom" : "option";
    const chosen = options.slice(0, Math.min(2, options.length)).map((option) => option.label);
    return {
      question: `${labelFor("ordinary", index, "decision")} ${questionIndex + 1}: choose the intended behavior?`,
      header: `Case ${index + questionIndex + 1}`,
      options,
      ...(multi ? { multiSelect: true } : {}),
      expected: answerFor(kind, chosen, `Custom answer ${index}-${questionIndex}`),
    };
  });
  return {
    id,
    stratum: "ordinary",
    classification: multi ? "legacy-multi" : custom ? "legacy-custom" : "legacy-single",
    comparisonScope: index % 5 === 0 ? "local-only" : "shared",
    canonicalInput: { questions: questions.map(({ expected: _expected, ...question }) => question) },
    expected: { outcome: "completed", classification: "answer-captured", answers: questions.map((question, questionIndex) => ({ questionIndex, ...question.expected })) },
    terminalConstraints: { requiresRealTTY: false, requiresConfiguredEditor: false, maxStages: 4, explicitApproval: true },
    visualPrompt: { required: false, prompt: null, comparisonRubric: [] },
  };
}

function visualScenario(id, index) {
  const options = ["Editorial", "Technical", "Accessible"].map((name, optionIndex) => ({
    id: `visual-${index}-${optionIndex}`,
    label: `${name} direction`,
    description: `A deterministic ${name.toLowerCase()} visual treatment for decision ${index}.`,
  }));
  return {
    id,
    stratum: "visual",
    classification: index % 2 ? "visual-draft" : "visual-reference",
    comparisonScope: "local-only",
    canonicalInput: {
      title: `Visual decision ${index}`,
      reviewId: id,
      stages: [{
        id: "direction", kind: "draft", header: "Direction",
        prompt: `Choose the visual direction for benchmark case ${index}.`,
        options,
        allowRevision: true, required: true,
      }],
    },
    expected: { outcome: "completed", classification: "visual-choice", answers: [{ stageId: "direction", kind: "option", answer: options[0].label }] },
    terminalConstraints: { requiresRealTTY: true, requiresConfiguredEditor: false, maxStages: 6, explicitApproval: true },
    visualPrompt: {
      required: true,
      prompt: `Create two polished terminal-safe interface mockups for decision ${index}: editorial, technical, and accessible alternatives. Preserve identical content and dimensions.`,
      comparisonRubric: ["information hierarchy", "contrast", "terminal readability", "task clarity"],
    },
  };
}

function adversarialScenario(id, index) {
  const unicode = index % 2 === 0;
  const shared = index % 5 !== 0;
  const labelA = unicode ? "Café plan — naïve" : "Boundary plan — naïve";
  const labelB = unicode ? "Δ fallback — 很好" : "Fallback path — stable";
  const input = {
    questions: [{
      question: unicode ? `Boundary ${index}: choose Café or Δ without losing the user’s intent — 你好?` : `Boundary ${index}: choose a stable fallback without losing intent?`,
      header: unicode ? "边界" : "Boundary",
      options: [
        { label: labelA, description: "Handles Unicode, line endings, and long text." },
        { label: labelB, description: unicode ? "保留换行并保持答案。" : "Preserves newlines and keeps the answer." },
      ],
      ...(index % 3 === 0 ? { multiSelect: true } : {}),
    }],
  };
  const answer = input.questions[0].multiSelect ? { kind: "multi", selected: [labelA, labelB] } : { kind: "option", answer: labelA };
  return {
    id,
    stratum: "adversarial",
    classification: unicode ? "unicode-boundary" : "format-boundary",
    comparisonScope: shared ? "shared" : "local-only",
    canonicalInput: input,
    expected: { outcome: "completed", classification: "boundary-answer", answers: [{ questionIndex: 0, ...answer }] },
    terminalConstraints: { requiresRealTTY: false, requiresConfiguredEditor: index % 3 === 0, maxStages: 6, explicitApproval: true },
    visualPrompt: { required: false, prompt: null, comparisonRubric: [] },
  };
}

export function generateCorpus({ count = 1000, seed = 20260925 } = {}) {
  parseCount(count);
  parseSeed(seed);
  const allocation = allocateStrata(count);
  const random = rng(seed);
  const scenarios = [];
  const counters = { ordinary: 0, visual: 0, adversarial: 0 };
  for (let index = 0; index < count; index += 1) {
    const stratum = index < allocation.ordinary ? "ordinary" : index < allocation.ordinary + allocation.visual ? "visual" : "adversarial";
    counters[stratum] += 1;
    const serial = String(counters[stratum]).padStart(4, "0");
    const id = `${stratum}-${serial}`;
    const variant = Math.floor(random() * 1000);
    const scenario = stratum === "ordinary" ? ordinaryScenario(id, counters.ordinary, variant, seed)
      : stratum === "visual" ? visualScenario(id, counters.visual)
      : adversarialScenario(id, counters.adversarial);
    scenarios.push(scenario);
  }
  return normalizeCorpus({ schemaVersion: SCHEMA_VERSION, kind: "benchmark-corpus", seed, count, strata: allocation, scenarios });
}

function validateExpectedAnswer(answer, label) {
  requireRecord(answer, label);
  if (!new Set(["option", "multi", "custom", "cancel", "skip", "revision", "reject"]).has(answer.kind)) throw new BenchmarkError("invalid_shape", `${label}.kind is invalid.`);
  if ((answer.kind === "option" || answer.kind === "custom") && typeof answer.answer !== "string") throw new BenchmarkError("invalid_shape", `${label}.answer must be a string.`);
  if (answer.kind === "multi" && (!Array.isArray(answer.selected) || !answer.selected.length || answer.selected.some((item) => typeof item !== "string"))) {
    throw new BenchmarkError("invalid_shape", `${label}.selected must be a non-empty string array.`);
  }
}

function validateTerminalConstraints(value, label) {
  requireRecord(value, label);
  for (const key of ["requiresRealTTY", "requiresConfiguredEditor", "explicitApproval"]) {
    if (typeof value[key] !== "boolean") throw new BenchmarkError("invalid_shape", `${label}.${key} must be boolean.`);
  }
  if (!Number.isInteger(value.maxStages) || value.maxStages < 1 || value.maxStages > 6) throw new BenchmarkError("invalid_shape", `${label}.maxStages must be 1-6.`);
}

function validateVisualPrompt(value, label) {
  requireRecord(value, label);
  if (typeof value.required !== "boolean") throw new BenchmarkError("invalid_shape", `${label}.required must be boolean.`);
  if (value.required && (typeof value.prompt !== "string" || !value.prompt.trim())) throw new BenchmarkError("invalid_shape", `${label}.prompt is required.`);
  if (value.prompt !== null && typeof value.prompt !== "string") throw new BenchmarkError("invalid_shape", `${label}.prompt must be string or null.`);
  if (!Array.isArray(value.comparisonRubric) || value.comparisonRubric.some((item) => typeof item !== "string")) throw new BenchmarkError("invalid_shape", `${label}.comparisonRubric must be a string array.`);
}

function validateCanonicalInput(value, label, allowInvalid = false) {
  requireRecord(value, label);
  let normalized;
  try {
    normalized = normalizeReview(JSON.parse(JSON.stringify(value)), 1);
  } catch (error) {
    if (allowInvalid) return null;
    throw new BenchmarkError("invalid_shape", `${label} is not a valid review: ${error.message}`, { cause: error });
  }
  // Reserved-label collisions are a *valid input* rule. A scenario that is
  // marked inputValid:false exists precisely to probe that rejection, so the
  // reserved scan is skipped for it; absoluteScore asserts the rejection.
  if (allowInvalid) return normalized;
  for (const stage of normalized.stages) {
    for (const option of stage.options) {
      if (ALL_RESERVED.has(option.label.trim().toLowerCase()) || [...ALL_RESERVED].some((reserved) => reserved.toLowerCase() === option.label.trim().toLowerCase())) {
        throw new BenchmarkError("reserved_label", `${label} uses reserved option label ${option.label}.`);
      }
    }
  }
  return normalized;
}

export function validateCorpus(value) {
  const corpus = requireRecord(value, "corpus");
  assertNoCredentials(corpus);
  if (corpus.schemaVersion !== SCHEMA_VERSION || corpus.kind !== "benchmark-corpus") throw new BenchmarkError("invalid_shape", "Unsupported corpus schemaVersion or kind.");
  parseCount(corpus.count);
  parseSeed(corpus.seed);
  if (!Array.isArray(corpus.scenarios) || corpus.scenarios.length !== corpus.count) throw new BenchmarkError("count_mismatch", "Corpus scenario count does not match count.");
  const expectedAllocation = allocateStrata(corpus.count);
  const actual = { ordinary: 0, visual: 0, adversarial: 0 };
  const ids = new Set();
  const canonicalInputs = new Set();
  for (const [index, scenario] of corpus.scenarios.entries()) {
    const label = `scenarios[${index}]`;
    requireRecord(scenario, label);
    requireString(scenario.id, `${label}.id`);
    if (ids.has(scenario.id)) throw new BenchmarkError("duplicate_id", `Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (!STRATA.includes(scenario.stratum) || !["shared", "local-only"].includes(scenario.comparisonScope)) throw new BenchmarkError("invalid_shape", `${label} has an invalid stratum or comparisonScope.`);
    requireString(scenario.classification, `${label}.classification`);
    actual[scenario.stratum] += 1;
    const inputValid = scenario.inputValid !== false;
    const normalizedInput = validateCanonicalInput(scenario.canonicalInput, `${label}.canonicalInput`, !inputValid);
    if (inputValid && !normalizedInput) throw new BenchmarkError("invalid_shape", `${label}.canonicalInput could not be normalized.`);
    if (!inputValid && scenario.expected.outcome !== "invalid") throw new BenchmarkError("invalid_shape", `${label} marks input invalid but expected outcome is not invalid.`);
    const canonical = stableStringify(normalizedInput ?? scenario.canonicalInput);
    if (canonicalInputs.has(canonical)) throw new BenchmarkError("duplicate_scenario", `Duplicate canonical input at ${scenario.id}.`);
    canonicalInputs.add(canonical);
    const expected = requireRecord(scenario.expected, `${label}.expected`);
    requireString(expected.outcome, `${label}.expected.outcome`);
    if (!TERMINAL_STATUSES.has(expected.outcome)) throw new BenchmarkError("invalid_shape", `${label}.expected.outcome ${expected.outcome} is not a terminal status.`);
    requireString(expected.classification, `${label}.expected.classification`);
    if (!Array.isArray(expected.answers)) throw new BenchmarkError("invalid_shape", `${label}.expected.answers must be an array.`);
    expected.answers.forEach((answer, answerIndex) => validateExpectedAnswer(answer, `${label}.expected.answers[${answerIndex}]`));
    if (inputValid && expected.outcome === "invalid") {
      throw new BenchmarkError("invalid_shape", `${label} expects a rejection but marks its input valid.`);
    }
    if (!inputValid && scenario.comparisonScope !== "local-only") {
      throw new BenchmarkError("invalid_scope", `${label} invalid input must be local-only.`);
    }
    validateTerminalConstraints(scenario.terminalConstraints, `${label}.terminalConstraints`);
    validateVisualPrompt(scenario.visualPrompt, `${label}.visualPrompt`);
    if (scenario.stratum === "visual" && !scenario.visualPrompt.required) throw new BenchmarkError("stratum_mismatch", `${scenario.id} must include visual prompt metadata.`);
  }
  const declared = requireRecord(corpus.strata, "strata");
  for (const stratum of STRATA) {
    if (declared[stratum] !== actual[stratum] || expectedAllocation[stratum] !== actual[stratum]) {
      throw new BenchmarkError("stratum_mismatch", `${stratum} count mismatch: declared ${declared[stratum]}, expected ${expectedAllocation[stratum]}, actual ${actual[stratum]}.`);
    }
  }
  return true;
}

export function normalizeCorpus(value) {
  validateCorpus(value);
  return structuredClone(value);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { count: "number", seed: "number", out: "string", corpus: "string", validate: "boolean", import: "string" });
  if (args.validate) {
    const path = args.corpus ?? args.out ?? ".pi/benchmark/corpus.json";
    const { readJson } = await import("./common.mjs");
    const existing = await readJson(path, "corpus_missing");
    validateCorpus(existing);
    process.stdout.write(`${JSON.stringify({ corpus: resolve(path), valid: true, count: existing.count })}\n`);
    return;
  }
  // --import validates an externally assembled corpus (for example the
  // Space Bunny Alpha shards) and re-emits it through the same gate instead of
  // silently trusting the file.
  if (args.import) {
    const { readJson } = await import("./common.mjs");
    const imported = await readJson(args.import, "corpus_missing");
    const corpus = normalizeCorpus(imported);
    const out = await writeJson(args.out ?? ".pi/benchmark/corpus.json", corpus);
    process.stdout.write(`${JSON.stringify({ out: resolve(out), imported: resolve(args.import), count: corpus.count, strata: corpus.strata, seed: corpus.seed })}\n`);
    return;
  }
  const corpus = generateCorpus({ count: parseCount(args.count), seed: parseSeed(args.seed) });
  const out = await writeJson(args.out ?? ".pi/benchmark/corpus.json", corpus);
  process.stdout.write(`${JSON.stringify({ out: resolve(out), count: corpus.count, strata: corpus.strata, seed: corpus.seed })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`benchmark:corpus: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}
