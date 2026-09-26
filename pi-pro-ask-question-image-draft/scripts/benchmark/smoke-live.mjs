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
import { PROVISIONABLE_EDITORS, resolveEditorCommand, whichExecutable } from "./editor.mjs";
import { DEFAULT_IMAGE_DIR, detectImage } from "./images.mjs";
import { aggregateSessionEvidence, HAPPY_SESSION, SESSION_MODES, sessionPlan } from "./live-sessions.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/**
 * Resolve the editor the gate will prove.
 *
 * Resolution follows Pi's own order and records which source answered, so the
 * evidence names the editor Pi would really launch. There is no bespoke
 * override variable: a recorded run that passed must be the run the next
 * auditor reproduces. When the resolved editor is not installed the gate
 * provisions one it can actually run and says so, because "nano is missing" is
 * a property of the machine, not a verdict about the package.
 */
export async function resolveEditor() {
  let settingsEditor = "";
  let piResolved = "";
  try {
    const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const manager = SettingsManager.create(process.cwd(), undefined, { projectTrusted: true });
    settingsEditor = manager.getProjectSettings?.()?.externalEditor ?? manager.getGlobalSettings?.()?.externalEditor ?? "";
    piResolved = manager.getExternalEditorCommand()?.trim() ?? "";
  } catch {
    settingsEditor = "";
  }
  const resolved = resolveEditorCommand({
    settingsEditor,
    visual: process.env.VISUAL,
    editor: process.env.EDITOR,
  });
  // The gate must agree with Pi about which editor would be launched, or the
  // walk proves something the package never does.
  if (piResolved && resolved.command && piResolved !== resolved.command) {
    throw new BenchmarkError("editor_resolution_mismatch", `Pi resolves the external editor to "${piResolved}" but the gate derived "${resolved.command}" from ${resolved.source}.`);
  }
  if (resolved.runnable) return { ...resolved, provisioned: null };
  const candidate = PROVISIONABLE_EDITORS.map((name) => ({ name, executable: whichExecutable(name) })).find((item) => item.executable);
  if (!candidate) {
    throw new BenchmarkError("editor_unavailable", `Pi resolves the external editor to "${resolved.command}" (${resolved.source}) and none of ${PROVISIONABLE_EDITORS.join(", ")} is installed, so the editor handoff cannot be proven on this machine.`);
  }
  return {
    source: resolved.source,
    command: candidate.name,
    executable: candidate.executable,
    runnable: true,
    provisioned: `Pi resolved "${resolved.command}" from ${resolved.source} and that binary is not installed; the gate provisioned "${candidate.name}" instead.`,
  };
}

export async function liveSmokePreconditions({ image, stdinIsTTY, stdoutIsTTY, editor }) {
  if (!image) throw new Error("--image <path> is required.");
  if (!stdinIsTTY || !stdoutIsTTY) throw new Error("Live smoke requires a real interactive TTY on stdin and stdout.");
  if (typeof editor !== "string" || !editor.trim()) throw new Error("Live smoke requires an external editor to be resolvable.");
  if (!whichExecutable(editor)) throw new Error(`Resolved external editor "${editor}" is not an executable on PATH.`);
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

/**
 * Run every session on its own pseudo-terminal and fold the evidence.
 *
 * Each session is a separate process on a separate PTY, because reject and
 * cancel end a review: one walk cannot both answer and cancel. A session that
 * did not run is a failure here, not an omission, so the aggregate can only
 * pass with all five sessions' evidence present.
 */
export async function runLiveSmoke({ image, editor, editorSource = "unknown", out = ".pi/benchmark/live-smoke.json", timeout = 90, sessions = SESSION_MODES } = {}) {
  const preconditions = await liveSmokePreconditions({
    image, stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY), editor,
  });
  const budget = Math.max(30, timeout - 20);
  const entries = [];
  for (const mode of sessions) {
    const driverOut = resolve(`.pi/benchmark/live-smoke-evidence-${mode}.json`);
    const startedAt = Date.now();
    const pty = await runPty({
      out: driverOut,
      // The happy path carries the image, the editor round trip and the whole
      // collapse/reopen walk; the behaviour sessions are short by design.
      timeout: mode === HAPPY_SESSION ? budget : Math.max(30, Math.min(60, budget)),
      driverArgs: [`--session=${mode}`, `--image=${preconditions.image}`, `--timeout=${mode === HAPPY_SESSION ? budget : Math.max(30, Math.min(60, budget))}`],
    });
    let evidence;
    try {
      evidence = JSON.parse(await readFile(driverOut, "utf8"));
    } catch (error) {
      evidence = { status: "failed", steps: [], errors: { "read-evidence": String(error) } };
    }
    entries.push({
      plan: sessionPlan(mode, { imagePath: preconditions.image }),
      evidence,
      exitCode: pty.code,
      durationMs: Date.now() - startedAt,
      stderr: pty.stderr.trim().slice(0, 400),
    });
  }
  const aggregate = aggregateSessionEvidence(entries);
  const exits = Object.fromEntries(entries.map((entry) => [entry.plan.mode, entry.exitCode]));
  const passed = Object.values(exits).every((code) => code === 0)
    && entries.every((entry) => entry.evidence?.pty?.usedPseudoTerminal === true)
    && aggregate.status === "passed";
  const record = {
    kind: "benchmark-live-smoke",
    status: passed ? "passed" : "failed",
    observedAt: new Date().toISOString(),
    details: [
      `${preconditions.editor} (${editorSource})`,
      `image ${preconditions.mimeType} ${preconditions.width}x${preconditions.height}`,
      `sessions ${aggregate.sessions.filter((session) => session.passed).length}/${aggregate.sessions.length}`,
      `steps ${aggregate.steps.length}`,
      aggregate.sessions.filter((session) => !session.passed).map((session) => `${session.session}: ${session.reasons.join("; ")}`).join(" | "),
      entries.map((entry) => entry.stderr).filter(Boolean).join(" | "),
    ].filter(Boolean).join(" | "),
    preconditions,
    editor: { command: preconditions.editor, source: editorSource, resolved: entries[0]?.evidence?.observed?.editor ?? null },
    assertions: aggregate.assertions,
    steps: aggregate.steps,
    sessions: aggregate.sessions,
    missingSessions: aggregate.missingSessions,
    errors: aggregate.errors,
    pty: {
      usedPseudoTerminal: true,
      exitCodes: exits,
      durationsMs: Object.fromEntries(entries.map((entry) => [entry.plan.mode, entry.durationMs])),
    },
  };
  await writeJson(out, record);
  return record;
}


/**
 * Resolve the image the smoke must render.
 *
 * A contract check that names a canonical file renders exactly that file. A
 * missing path is a hard failure: silently substituting some other generated
 * image would let a pass describe a file nobody asked about.
 */
export async function resolveSmokeImage(requested, { root = process.cwd() } = {}) {
  if (!requested) {
    const manifest = await readJson(".pi/benchmark/image-manifest.json", "manifest_missing");
    const first = manifest.images?.[0];
    if (!first) throw new BenchmarkError("image_missing", "No generated benchmark image is available for the live smoke.");
    return { path: resolve(first.path), substituted: false, requested: null };
  }
  const candidate = resolve(requested);
  try {
    await access(candidate, constants.R_OK);
  } catch {
    throw new BenchmarkError("image_missing", `No readable image at ${candidate}. Generate it with \`npm run benchmark:images -- --max 600\` or pass a path that exists.`);
  }
  return { path: candidate, substituted: false, requested: candidate };
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
  const args = parseArgs(argv, { image: "string", out: "string", timeout: "number", "in-pty": "boolean", sessions: "string" });
  const inPty = args["in-pty"] === true;
  if (!inPty && !(process.stdin.isTTY && process.stdout.isTTY)) {
    const code = await runInsidePty(argv.filter((token) => !token.startsWith("--in-pty")));
    process.exitCode = code;
    return;
  }
  const editor = await resolveEditor();
  // The extension resolves the editor itself through Pi, so a provisioned
  // editor is injected the way Pi itself reads one: $VISUAL, which sits above
  // $EDITOR and Pi's default in Pi's own resolution order.
  if (editor.provisioned) process.env.VISUAL = editor.command;
  const image = await resolveSmokeImage(args.image);
  // A subset is a debugging aid only: the aggregate can only pass when every
  // session ran, so `--sessions` can produce evidence, never a pass.
  const requested = typeof args.sessions === "string" && args.sessions.trim()
    ? args.sessions.split(",").map((value) => value.trim()).filter(Boolean)
    : SESSION_MODES;
  const unknown = requested.filter((mode) => !SESSION_MODES.includes(mode));
  if (unknown.length) throw new BenchmarkError("unknown_session", `Unknown live session(s) ${unknown.join(", ")}; expected some of ${SESSION_MODES.join(", ")}.`);
  const record = await runLiveSmoke({ image: image.path, editor: editor.command, editorSource: editor.provisioned ? `provisioned (${editor.source} -> ${editor.command})` : editor.source, out: args.out, timeout: args.timeout ?? 90, sessions: requested });
  record.image = { requested: image.requested ?? image.path, rendered: image.path, substituted: image.substituted };
  record.editor = { ...record.editor, provisioned: editor.provisioned, resolved: editor.resolved };
  await writeJson(args.out ?? ".pi/benchmark/live-smoke.json", record);
  await writeStdout(`${JSON.stringify({ status: record.status, details: record.details, image: record.image, editor: record.editor })}\n`);
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
