#!/usr/bin/env node
/**
 * Isolated RPiV adapter. Pi's extension loader (jiti) is the only code path
 * allowed to evaluate the reference package's TypeScript. The child returns
 * JSON on stdout and never mutates settings, credentials, or auth.json.
 *
 * The adapter passes the *whole* question object through, so preview text,
 * multiSelect, and notes reach the reference implementation instead of being
 * silently dropped, and it reports which capabilities it actually exercised.
 */
import { createInterface } from "node:readline";

const REFERENCE = process.env.PI_BENCHMARK_RPIV_ROOT ?? "/home/dracon/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question";
const LOADER = process.env.PI_BENCHMARK_LOADER ?? "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
const CASE_TIMEOUT_MS = Number(process.env.PI_BENCHMARK_REFERENCE_TIMEOUT_MS ?? 5000);

function optionKeyOf(question, index) {
  const option = question.options?.[index];
  if (!option) return undefined;
  return option.key ?? option.id ?? option.label;
}

function answerScript(questions, expectedAnswers = []) {
  return questions.map((question, questionIndex) => {
    const expected = expectedAnswers.find((answer) => answer.questionIndex === questionIndex)
      ?? { kind: "option", answer: question.options?.[0]?.label };
    const pick = (value) => question.options.findIndex((option) => option.label === value);
    const selections = expected.selected ?? expected.optionLabels;
    return {
      questionIndex,
      kind: expected.kind,
      answer: expected.answer,
      selected: selections,
      // Indices the reference dialog expects, derived from its own option list.
      optionIndex: pick(expected.answer),
      optionIndices: (selections ?? []).map(pick).filter((value) => value >= 0),
      custom: expected.kind === "custom" ? expected.answer : undefined,
    };
  });
}

function formatOptionLine(question, index) {
  return `${index + 1}. ${question.options[index].label} — ${question.options[index].description ?? ""}`;
}

function optionLineFor(question, label) {
  const index = question.options.findIndex((option) => option.label === label);
  return index >= 0 ? formatOptionLine(question, index) : undefined;
}

/**
 * RPiV's RPC contract: a single-select question is one `ui.select` over
 * "N. label — description" rows plus a trailing "Type something." row; a custom
 * answer is that row followed by `ui.input`; a multi-select question is one
 * `ui.input` taking comma-separated 1-based indices. Dismissing any dialog
 * (`undefined`) declines the questionnaire. The mock follows that protocol
 * exactly, so previews, multi-select, and custom answers are actually
 * exercised instead of being silently degraded.
 */
function mockContext(input, script, capabilities) {
  const questions = input.questions;
  let questionIndex = 0;
  const controller = new AbortController();
  return {
    context: {
      hasUI: true,
      mode: "rpc",
      signal: controller.signal,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: {
        async select(title, choices) {
          if (script.expectedOutcome === "cancelled") return undefined;
          const question = questions[questionIndex];
          const answer = script[questionIndex];
          if (!question || !answer) return undefined;
          if (question.options.some((option) => option.preview)) capabilities.previews = true;
          if (answer.kind === "custom") {
            // The host-owned "Type something." row is always last.
            return choices[question.options.length] ?? choices[choices.length - 1];
          }
          const line = optionLineFor(question, answer.answer ?? answer.selected?.[0]);
          if (!line) return undefined;
          questionIndex += 1;
          return line;
        },
        async input() {
          if (script.expectedOutcome === "cancelled") return undefined;
          const question = questions[questionIndex];
          const answer = script[questionIndex];
          if (!question || !answer) return undefined;
          if (answer.kind === "custom") {
            questionIndex += 1;
            return answer.answer;
          }
          if (answer.kind === "multi" || question.multiSelect) {
            capabilities.multiSelect = true;
            const selected = answer.selected ?? [];
            const indices = selected
              .map((label) => question.options.findIndex((option) => option.label === label) + 1)
              .filter((index) => index >= 1);
            questionIndex += 1;
            return indices.join(",");
          }
          return undefined;
        },
        async confirm() { return true; },
        notify() {},
      },
    },
    advanceAfterCustom: true,
  };
}

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`reference_case_timeout ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

try {
  const request = await readRequest();
  const { loadExtensions } = await import(`file://${LOADER}`);
  const loaded = await loadExtensions([`${REFERENCE}/index.ts`], process.cwd());
  if (loaded.errors.length) throw new Error(`Reference adapter failed: ${loaded.errors.map((item) => item.error).join("; ")}`);
  const extension = loaded.extensions.find((item) => item.resolvedPath.startsWith(REFERENCE));
  const tool = extension?.tools.get("ask_user_question")?.definition;
  if (!tool) throw new Error("Reference adapter did not register ask_user_question.");
  const output = [];
  for (const scenario of request.scenarios) {
    // Full fidelity: the whole question object reaches the reference, minus
    // fields that only this package understands.
    const questions = (scenario.canonicalInput.questions ?? []).map(({ image, ...question }) => question);
    const input = { questions };
    if (scenario.canonicalInput.notes) input.notes = scenario.canonicalInput.notes;
    const capabilities = { multiSelect: false, previews: questions.some((q) => q.options?.some((o) => o.preview)), notes: Boolean(input.notes) };
    const script = answerScript(questions, scenario.expected?.answers ?? []);
    script.expectedOutcome = scenario.expected?.outcome;
    const { context } = mockContext(input, script, capabilities);
    try {
      const result = await withTimeout(
        tool.execute(`benchmark-${scenario.id}`, input, context.signal, undefined, context),
        CASE_TIMEOUT_MS,
        scenario.id,
      );
      output.push({ id: scenario.id, ok: true, result, capabilities });
    } catch (error) {
      output.push({ id: scenario.id, ok: false, error: error instanceof Error ? error.message : String(error), capabilities });
    }
  }
  process.stdout.write(JSON.stringify({ adapter: "pi-loadExtensions-jiti-isolated-child", reference: REFERENCE, output }));
} catch (error) {
  process.stderr.write(`REFERENCE_ADAPTER_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
