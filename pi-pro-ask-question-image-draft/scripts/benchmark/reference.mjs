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

function mockContext(input, script, capabilities) {
  const questions = input.questions;
  let questionIndex = 0;
  const controller = new AbortController();
  const inMulti = new Set();
  return {
    context: {
      hasUI: true,
      mode: "rpc",
      signal: controller.signal,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: {
        async select(title, choices) {
          const answer = script[questionIndex];
          if (!answer) return undefined;
          if (title && /visual review|approve these answers/i.test(title)) {
            if (script.expectedOutcome === "rejected") return choices[choices.length - 1];
            return choices[choices.length - 1];
          }
          if (answer.kind === "custom") {
            const customChoice = choices.findIndex((choice) => /type something|enter a custom|free-?form/i.test(String(choice)));
            return customChoice >= 0 ? choices[customChoice] : undefined;
          }
          if (answer.kind === "multi" || questions[questionIndex]?.multiSelect) {
            const wanted = answer.selected ?? [];
            const already = wanted.filter((label) => inMulti.has(label));
            if (already.length < wanted.length) {
              const next = wanted.find((label) => !inMulti.has(label));
              inMulti.add(next);
              return choices[optionKeyOf(questions[questionIndex], questions[questionIndex].options.findIndex((o) => o.label === next))];
            }
            capabilities.multiSelect = true;
            inMulti.clear();
            questionIndex += 1;
            const done = choices.findIndex((choice) => /done|confirm|submit|continue/i.test(String(choice)));
            return done >= 0 ? choices[done] : choices[choices.length - 1];
          }
          const index = answer.optionIndex;
          if (index === undefined || index < 0) return undefined;
          questionIndex += 1;
          return choices[index];
        },
        async input() {
          const answer = script.find((item) => item.questionIndex === questionIndex - 1 && item.kind === "custom");
          return answer?.custom;
        },
        async confirm() { return true; },
        notify() {},
      },
    },
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
