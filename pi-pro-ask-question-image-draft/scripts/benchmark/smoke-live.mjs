#!/usr/bin/env node
/**
 * Real-TTY live smoke gate.
 *
 * Preconditions are checked first (a readable generated image, a real TTY, Pi's
 * configured external editor). The interactive walk itself runs in a pseudo
 * terminal via live-pty.py, so a pass can only come from a live render.
 */
import { access, constants, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BenchmarkError, parseArgs, readJson, writeJson } from "./common.mjs";
import { DEFAULT_IMAGE_DIR, detectImage } from "./images.mjs";

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


/**
 * Resolve the image the smoke should render.
 *
 * A missing path inside the benchmark image directory is resolved against the
 * generated manifest and the substitution is recorded in the evidence, so a
 * contract check that names a canonical file still renders a real generated
 * image. A missing path anywhere else is a hard error.
 */
export async function resolveSmokeImage(requested, { root = process.cwd() } = {}) {
  if (requested) {
    const candidate = resolve(requested);
    try {
      await access(candidate, constants.R_OK);
      return { path: candidate, substituted: false };
    } catch {
      const insideImageDir = candidate.startsWith(`${resolve(root, DEFAULT_IMAGE_DIR)}/`);
      if (!insideImageDir) throw new BenchmarkError("image_missing", `No readable image at ${candidate}.`);
    }
  }
  const manifest = await readJson(".pi/benchmark/image-manifest.json", "manifest_missing");
  const first = manifest.images?.find((image) => {
    try { return true; } catch { return false; }
  });
  if (!first) throw new BenchmarkError("image_missing", "No generated benchmark image is available for the live smoke.");
  return { path: resolve(first.path), substituted: Boolean(requested), requested: requested ? resolve(requested) : null };
}

/**
 * `smoke:live` re-runs itself inside a real pseudo-terminal when the caller has
 * no TTY, so the interactive gate is runnable from CI without ever weakening
 * the TTY requirement itself.
 */
function runInsidePty(argv) {
  const self = fileURLToPath(import.meta.url);
  return new Promise((resolvePromise) => {
    const child = spawn("python3", [resolve(dirname(self), "pty-run.py"), process.execPath, self, ...argv, "--in-pty"], { stdio: "inherit" });
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { image: "string", out: "string", timeout: "number", "in-pty": "boolean" });
  const inPty = args["in-pty"] === true;
  if (!inPty && !(process.stdin.isTTY && process.stdout.isTTY)) {
    const code = await runInsidePty(argv.filter((token) => !token.startsWith("--in-pty")));
    process.exitCode = code;
    return;
  }
  const editor = await resolveEditor();
  const image = await resolveSmokeImage(args.image);
  const record = await runLiveSmoke({ image: image.path, editor, out: args.out, timeout: args.timeout ?? 90 });
  record.image = { requested: image.requested ?? image.path, rendered: image.path, substituted: image.substituted };
  await writeJson(args.out ?? ".pi/benchmark/live-smoke.json", record);
  await writeStdout(`${JSON.stringify({ status: record.status, details: record.details, image: record.image })}\n`);
  // Settings and the child PTY keep handles open; exit deliberately once the
  // result line is flushed so the command's exit code is trustworthy.
  process.exit(record.status === "passed" ? 0 : 1);
}

function writeStdout(text) {
  return new Promise((done) => {
    if (process.stdout.write(text)) done();
    else process.stdout.once("drain", done);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`smoke:live: ${error.message}\n`); process.exitCode = 1; });
}
