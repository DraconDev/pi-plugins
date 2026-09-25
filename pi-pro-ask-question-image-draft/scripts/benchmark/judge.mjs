#!/usr/bin/env node
/**
 * Optional, explicit AI judging. Importing this module is side-effect free;
 * createJudgeRuntime() is called only by --judge. ModelRuntime reads Pi's
 * existing credential store, but no auth object is returned or serialized.
 */
import { BenchmarkError, SCHEMA_VERSION, wilsonLowerBound } from "./common.mjs";

export const JUDGE_MODEL = Object.freeze({ provider: "openrouter", model: "stealth/space-bunny-alpha" });

export function judgePrompt(pair) {
  return [
    "You are an independent visual decision-quality judge.",
    "Return exactly one JSON object with keys winner (A, B, or tie), utilityA (number 0..1), utilityB (number 0..1), severeFailure (none, A, B, or both), and rationale (string).",
    "Judge decision utility, visual fidelity, and task clarity. Do not infer implementation identity from labels.",
    JSON.stringify(pair),
  ].join("\n");
}

export function parseStrictJudge(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch (cause) { throw new BenchmarkError("judge_invalid_json", "Judge did not return strict JSON.", { cause }); }
  if (!parsed || typeof parsed !== "object" || !["A", "B", "tie"].includes(parsed.winner) || typeof parsed.utilityA !== "number" || typeof parsed.utilityB !== "number" || !["none", "A", "B", "both"].includes(parsed.severeFailure) || typeof parsed.rationale !== "string") {
    throw new BenchmarkError("judge_invalid_shape", "Judge JSON does not match the required schema.");
  }
  return parsed;
}

export async function createJudgeRuntime(options = {}) {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, ...options });
}

export async function runJudgePass(runtime, pair, reasoning) {
  const model = runtime.getModel(JUDGE_MODEL.provider, JUDGE_MODEL.model);
  if (!model) throw new BenchmarkError("judge_model_unavailable", `${JUDGE_MODEL.provider}/${JUDGE_MODEL.model} is unavailable in the local ModelRuntime catalog.`);
  const response = await runtime.completeSimple(model, {
    systemPrompt: judgePrompt(pair),
    messages: [{ role: "user", content: "Apply the judging rubric and emit the required JSON object only.", timestamp: 0 }],
  }, { reasoning, maxTokens: 800, temperature: 0 });
  const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
  return parseStrictJudge(text);
}

export function adjudicate(passes) {
  if (passes.length < 2) throw new BenchmarkError("judge_passes_missing", "Two independent judge passes are required.");
  if (passes[0].winner === passes[1].winner) return { winner: passes[0].winner, method: "agreement", passes };
  return { winner: "tie", method: "disagreement-adjudication-required", passes };
}

export function judgeSummary(results) {
  const wins = results.filter((item) => item.winner === "candidate").length;
  const n = results.length;
  return { count: n, candidateWins: wins, candidateWinRate: n ? wins / n : 0, wilson95LowerBound: wilsonLowerBound(wins, Math.max(1, n)) };
}

export const JUDGE_RESULT_SCHEMA = { schemaVersion: SCHEMA_VERSION, required: ["winner", "utilityA", "utilityB", "severeFailure", "rationale"] };
