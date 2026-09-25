#!/usr/bin/env node
import { resolve } from "node:path";

import { assertNoCredentials, BenchmarkError, parseArgs, readJson, SCHEMA_VERSION } from "./common.mjs";

const STRATA = ["ordinary", "visual", "adversarial"];

function requireEvidence(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BenchmarkError("missing_evidence", `${label} evidence is required.`);
  if (value.status !== "passed" && value.status !== "not_run" && value.status !== "failed") throw new BenchmarkError("missing_evidence", `${label}.status is invalid.`);
  if (value.status === "passed" && (typeof value.observedAt !== "string" || !value.observedAt || !Number.isFinite(Date.parse(value.observedAt)))) {
    throw new BenchmarkError("missing_evidence", `${label} requires observedAt evidence.`);
  }
  if (value.status === "passed" && (typeof value.details !== "string" || !value.details.trim())) throw new BenchmarkError("missing_evidence", `${label} requires details.`);
}

export function verifyAggregateReport(report) {
  assertNoCredentials(report);
  if (report?.schemaVersion !== SCHEMA_VERSION || report?.kind !== "benchmark-aggregate-report") throw new BenchmarkError("invalid_shape", "Unsupported aggregate report schema.");
  const corpus = report.corpus;
  if (!corpus || corpus.count !== 1000 || !corpus.strata || STRATA.some((stratum) => corpus.strata[stratum] === undefined)) throw new BenchmarkError("missing_evidence", "Corpus count and all stratum counts are required.");
  if (corpus.strata.ordinary !== 700 || corpus.strata.visual !== 200 || corpus.strata.adversarial !== 100) throw new BenchmarkError("count_mismatch", "Aggregate report must contain the 700/200/100 corpus split.");
  const comparison = report.comparison;
  if (!comparison || !Number.isFinite(comparison.deterministicAccuracy) || !Number.isFinite(comparison.wilson95LowerBound)) throw new BenchmarkError("missing_evidence", "Deterministic accuracy and Wilson lower bound are required.");
  if (comparison.deterministicAccuracy < 0 || comparison.deterministicAccuracy > 1 || comparison.wilson95LowerBound < 0 || comparison.wilson95LowerBound > 1) throw new BenchmarkError("invalid_shape", "Comparison metrics must be probabilities.");
  if (!comparison.gates || comparison.gates.accuracy !== true || comparison.gates.confidenceBound !== true) throw new BenchmarkError("gate_failed", "Deterministic accuracy and confidence-bound gates must pass.");
  const defects = report.defects;
  if (!Array.isArray(defects)) throw new BenchmarkError("missing_evidence", "Defect ledger is required.");
  const unresolvedCritical = defects.filter((defect) => (defect.severity === "P0" || defect.severity === "P1") && defect.status !== "resolved");
  if (unresolvedCritical.length) throw new BenchmarkError("unresolved_critical_defects", `Unresolved critical defects: ${unresolvedCritical.map((defect) => defect.id).join(", ")}.`);
  const image = report.images;
  if (!image || !image.gates || typeof image.visualUplift !== "number" || typeof image.severeFailureRate !== "number") throw new BenchmarkError("missing_evidence", "Visual uplift and severe-failure metrics are required.");
  if (image.gates.visualUplift !== true || image.gates.severeFailures !== true) throw new BenchmarkError("gate_failed", "Visual uplift and severe-failure gates must pass.");
  requireEvidence(report.liveSmoke, "liveSmoke");
  if (report.liveSmoke.status !== "passed") throw new BenchmarkError("missing_evidence", "A passed live TTY/editor smoke is required.");
  requireEvidence(report.activation, "activation");
  if (report.activation.claimed !== true) throw new BenchmarkError("missing_evidence", "Activation evidence is required before activation can be claimed.");
  if (typeof report.activation.details !== "string" || !report.activation.details.trim()) throw new BenchmarkError("missing_evidence", "Activation requires details.");
  if (report.activation.status !== "passed" || report.activation.afterGates !== true || !report.activation.gatesVerifiedAt || !report.activation.observedAt || Date.parse(report.activation.observedAt) < Date.parse(report.activation.gatesVerifiedAt)) {
    throw new BenchmarkError("activation_order_invalid", "Activation must be evidenced after all gates passed.");
  }
  return { verified: true, activationClaim: "evidenced" };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { verify: "string" });
  if (!args.verify) throw new BenchmarkError("invalid_arguments", "--verify <report.json> is required.");
  const report = await readJson(args.verify, "report_missing");
  const result = verifyAggregateReport(report);
  process.stdout.write(`${JSON.stringify({ report: resolve(args.verify), ...result })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`benchmark:report: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
