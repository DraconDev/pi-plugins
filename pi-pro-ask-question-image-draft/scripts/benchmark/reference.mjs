#!/usr/bin/env node
/**
 * Isolated RPiV adapter. Pi's extension loader (jiti) is the only code path
 * allowed to evaluate the reference package's TypeScript. The child returns
 * JSON on stdout and never mutates settings, credentials, or auth.json.
 */
import { createInterface } from "node:readline";

const REFERENCE = process.env.PI_BENCHMARK_RPIV_ROOT ?? "/home/dracon/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question";
const LOADER = process.env.PI_BENCHMARK_LOADER ?? "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

function answerScript(canonicalInput) {
  return canonicalInput.questions.map((question, questionIndex) => {
    const expected = question.expected ?? { kind: "option", answer: question.options[0].label };
    return { questionIndex, ...expected };
  });
}

function mockContext(input) {
  const questions = input.questions;
  const expected = answerScript(input);
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
          const answer = expected[questionIndex];
          if (!answer) return undefined;
          if (answer.kind === "multi") return `${questions[questionIndex].options.length + 1}. Type something.`;
          if (answer.kind === "custom") return `${questions[questionIndex].options.length + 1}. Type something.`;
          const optionIndex = questions[questionIndex].options.findIndex((option) => option.label === answer.answer);
          if (optionIndex < 0) return undefined;
          questionIndex += 1;
          return choices[optionIndex];
        },
        async input(title, placeholder) {
          const answer = expected[questionIndex];
          if (!answer) return undefined;
          if (answer.kind === "multi") {
            const indices = answer.selected.map((label) => questions[questionIndex].options.findIndex((option) => option.label === label) + 1);
            questionIndex += 1;
            return indices.join(",");
          }
          if (answer.kind === "custom") {
            questionIndex += 1;
            return answer.answer;
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
    const input = { questions: scenario.canonicalInput.questions };
    const { context } = mockContext(input);
    try {
      const result = await tool.execute(`benchmark-${scenario.id}`, input, context.signal, undefined, context);
      output.push({ id: scenario.id, ok: true, result });
    } catch (error) {
      output.push({ id: scenario.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  process.stdout.write(JSON.stringify({ adapter: "pi-loadExtensions-jiti-isolated-child", reference: REFERENCE, output }));
} catch (error) {
  process.stderr.write(`REFERENCE_ADAPTER_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
