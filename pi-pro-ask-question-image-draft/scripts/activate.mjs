#!/usr/bin/env node
/**
 * The gated activation, and nothing else.
 *
 * The objective allows activation only after every release gate passes, and it
 * allows exactly one settings change: replace the superseded RPiV entry with
 * this package. This script refuses to run unless the gates have passed, takes
 * a fresh backup first, and edits the settings file as *text* - one package
 * string is swapped, so every other byte of the file is preserved by
 * construction rather than by a re-serialised deep equal.
 *
 *   node scripts/activate.mjs --confirm-gates
 */
import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseArgs, readJson, writeJson } from "../scripts/benchmark/common.mjs";

const SETTINGS = resolve(process.env.PI_SETTINGS_PATH ?? "/home/dracon/.pi/agent/settings.json");
const BACKUP = resolve(process.env.PI_SETTINGS_BEFORE_PATH ?? "/home/dracon/.pi/agent/settings.before-pi-visual-review.json");
const PACKAGE = resolve(new URL("..", import.meta.url).pathname);
const SUPERSEDED = "npm:@juicesharp/rpiv-ask-user-question";

async function main() {
  const args = parseArgs(process.argv.slice(2), { "confirm-gates": "boolean", report: "string", out: "string" });
  if (args["confirm-gates"] !== true) {
    throw new Error("Refusing to activate without --confirm-gates. The release gate must pass first.");
  }
  // Gate first: activation is the last step, and only after every gate passed.
  const report = await readJson(args.report ?? ".pi/benchmark/report.json", "report_missing");
  if (report.releaseReady !== true) {
    const unmet = Object.entries(report.gates ?? {}).filter(([, value]) => value !== true).map(([name]) => `gate:${name}`);
    throw new Error(`Refusing to activate: the release gate is not met (${unmet.join(", ")}).`);
  }
  if (report.activation?.status === "passed") {
    throw new Error("The activation evidence already records a completed activation.");
  }

  const before = await readFile(SETTINGS, "utf8");
  const parsed = JSON.parse(before);
  assert.ok(Array.isArray(parsed.packages), "settings.packages must be an array");
  if (parsed.packages.includes(PACKAGE)) throw new Error("The local package is already active.");
  if (!parsed.packages.includes(SUPERSEDED)) throw new Error(`The superseded package ${SUPERSEDED} is not active; nothing to replace.`);

  // 1. A fresh, timestamped backup plus the canonical pre-activation copy.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const timestamped = `${BACKUP.replace(/\.json$/, "")}.${stamp}.json`;
  await copyFile(SETTINGS, timestamped);
  await copyFile(SETTINGS, BACKUP);

  // 2. Swap exactly one package string, in place, in the raw text.
  const token = JSON.stringify(SUPERSEDED);
  const occurrences = before.split(token).length - 1;
  if (occurrences !== 1) throw new Error(`Expected exactly one ${SUPERSEDED} entry in settings, found ${occurrences}.`);
  const after = before.replace(token, JSON.stringify(PACKAGE));
  await writeFile(SETTINGS, after, "utf8");

  // 3. Prove the edit was confined to that one entry.
  const reparsed = JSON.parse(await readFile(SETTINGS, "utf8"));
  const strip = (value) => JSON.stringify({ ...value, packages: value.packages.filter((entry) => entry !== PACKAGE && entry !== SUPERSEDED) });
  assert.equal(strip(reparsed), strip(parsed), "unrelated settings entries changed");
  assert.equal(reparsed.packages.filter((entry) => entry === PACKAGE).length, 1, "the local package must occur exactly once");
  assert.equal(reparsed.packages.includes(SUPERSEDED), false, "the superseded package must be absent");
  assert.equal(before.length - after.length, SUPERSEDED.length - PACKAGE.length, "the settings file must change by exactly the package entry");

  const record = {
    schemaVersion: 1,
    kind: "benchmark-activation",
    status: "passed",
    observedAt: new Date().toISOString(),
    details: `Replaced ${SUPERSEDED} with ${PACKAGE}; unrelated settings preserved byte-for-byte.`,
    settingsPath: SETTINGS,
    backupPath: BACKUP,
    timestampedBackup: timestamped,
    package: PACKAGE,
    superseded: SUPERSEDED,
    unrelatedSettingsPreserved: true,
    packagesBefore: parsed.packages,
    packagesAfter: reparsed.packages,
    gatesAtActivation: report.gates,
    releaseReadyAtActivation: true,
  };
  await writeJson(args.out ?? ".pi/benchmark/activation.json", record);
  process.stdout.write(`${JSON.stringify({ status: record.status, settingsPath: SETTINGS, backupPath: timestamped, packages: reparsed.packages.length })}\n`);
}

main().catch((error) => {
  process.stderr.write(`activate: ${error.message}\n`);
  process.exitCode = 1;
});
