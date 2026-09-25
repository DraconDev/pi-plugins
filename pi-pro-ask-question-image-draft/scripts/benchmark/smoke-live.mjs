#!/usr/bin/env node
/**
 * Real-TTY live smoke gate.
 *
 * Preconditions are checked first (a readable generated image, a real TTY, Pi's
 * configured external editor). The interactive walk itself runs in a pseudo
 * terminal via live-pty.py, so a pass can only come from a live render.
 */
import { access, constants, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs, readJson, writeJson } from "./common.mjs";
import { detectImage } from "./images.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export async function resolveEditor() {
  const override = process.env.PI_BENCHMARK_EDITOR?.trim();
  if (override) return override;
  try {
    const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
    return SettingsManager.create(process.cwd(), undefined, { projectTrusted: true }).getExternalEditorCommand()?.trim() ?? "";
  } catch {
    return "";
  }
}

export async function liveSmokePreconditions({ image, stdinIsTTY, stdoutIsTTY, editor }) {
  if (!image) throw new Error("--image <path> is required.");
  if (!stdinIsTTY || !stdoutIsTTY) throw new Error("Live smoke requires a real interactive TTY on stdin and stdout.");
  if (typeof editor !== "string" || !editor.trim()) throw new Error("Live smoke requires Pi's configured external editor; none is configured.");
  await access(resolve(image), constants.R_OK);
  const detected = detectImage(await readFile(resolve(image)));
  return { image: resolve(image), editor, tty: true, ...detected };
}

function runPty({ out, timeout, driverArgs = [] }) {
  return new Promise((resolvePromise) => {
    const child = spawn("python3", [
      resolve(HERE, "live-pty.py"),
      "--driver", resolve(HERE, "live-driver.mjs"),
      `--out=${out}`,
      `--keys-file=${out.replace(/\.json$/, "-keys.json")}`,
      "--timeout", String(timeout),
      ...driverArgs,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

export async function runLiveSmoke({ image, editor, out = ".pi/benchmark/live-smoke.json", timeout = 90 } = {}) {
  const preconditions = await liveSmokePreconditions({
    image, stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY), editor,
  });
  const driverOut = resolve(".pi/benchmark/live-smoke-evidence.json");
  const pty = await runPty({
    out: driverOut, timeout,
    driverArgs: [`--image=${preconditions.image}`, `--timeout=${Math.max(30, timeout - 20)}`],
  });
  let evidence;
  try {
    evidence = JSON.parse(await readFile(driverOut, "utf8"));
  } catch (error) {
    evidence = { status: "failed", steps: [], errors: [{ step: "read-evidence", error: String(error) }] };
  }
  const passed = pty.code === 0 && evidence.status === "passed" && evidence.assertions?.externalEditor === true
    && evidence.assertions?.collapseReopen === true && evidence.assertions?.finalReview === true
    && evidence.pty?.usedPseudoTerminal === true;
  const record = {
    kind: "benchmark-live-smoke",
    status: passed ? "passed" : "failed",
    observedAt: new Date().toISOString(),
    details: [
      preconditions.editor,
      `image ${preconditions.mimeType} ${preconditions.width}x${preconditions.height}`,
      `pty exit ${pty.code}`,
      `steps ${evidence.steps?.length ?? 0}`,
      evidence.failure ?? "",
      pty.stderr.trim().slice(0, 400),
    ].filter(Boolean).join(" | "),
    preconditions,
    assertions: evidence.assertions ?? null,
    steps: evidence.steps ?? [],
    errors: evidence.errors ?? [],
    pty: evidence.pty ?? { exitCode: pty.code, driverOutput: pty.stdout.trim().slice(0, 400) },
  };
  await writeJson(out, record);
  return record;
}


async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { image: "string", out: "string", timeout: "number" });
  const editor = await resolveEditor();
  if (!args.image) {
    // Default to the first generated benchmark image so the gate cannot be run
    // against a missing file.
    const manifest = await readJson(".pi/benchmark/image-manifest.json", "manifest_missing");
    const first = manifest.images?.[0];
    if (!first) throw new Error("No generated benchmark image is available for the live smoke.");
    args.image = first.path;
  }
  const record = await runLiveSmoke({ image: args.image, editor, out: args.out, timeout: args.timeout ?? 90 });
  process.stdout.write(`${JSON.stringify({ status: record.status, details: record.details })}\n`);
  if (record.status !== "passed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`smoke:live: ${error.message}\n`); process.exitCode = 1; });
}
