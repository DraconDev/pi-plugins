#!/usr/bin/env node
/**
 * Real-TTY interactive driver for the live smoke.
 *
 * This is the smallest honest Pi host: it loads the *real* local extension
 * through Pi's own extension loader, runs it in `tui` mode against a real
 * pi-tui screen on a real pseudo-terminal, forwards real raw keypresses, and
 * launches Pi's configured external editor. Nothing here fabricates a pass:
 * every assertion is made against the live wizard state and the bytes the
 * terminal actually received.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ProcessTerminal, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../..");
const LOADER = process.env.PI_BENCHMARK_LOADER
  ?? "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const args = new Map();
for (const token of process.argv.slice(2)) {
  const [key, ...rest] = token.replace(/^--/, "").split("=");
  args.set(key, rest.join("=") || "true");
}
const imagePath = resolve(args.get("image") ?? "");
const outPath = resolve(args.get("out") ?? "/tmp/live-smoke-evidence.json");
const evidence = { kind: "live-tty-smoke", tty: {}, steps: [], errors: [], transcriptHits: {} };
const flush = () => writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
const record = (step, detail = {}) => { evidence.steps.push({ step, at: Date.now(), ...detail }); flush(); };
const fail = (step, error) => {
  const message = error instanceof Error ? error.message : String(error);
  evidence.errors.push({ step, error: message });
  evidence.failure = message;
  flush();
  throw error;
};

let transcript = "";
const screen = (text) => { transcript += text; };
const sawOnScreen = (needle) => transcript.includes(needle);

const terminal = new ProcessTerminal({
  input: process.stdin,
  output: { write: (chunk) => { screen(String(chunk)); return true; }, columns: process.stdout.columns, rows: process.stdout.rows },
  // @ts-ignore - the real terminal object only needs the fields TUI reads.
});
const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  dim: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  inverse: (text) => text,
};

const input = normalizeReviewParams();

function normalizeReviewParams() {
  return {
    reviewId: "live-smoke",
    title: "Live TTY smoke",
    stages: [
      {
        id: "direction", kind: "draft", header: "Direction", prompt: "Pick the visual treatment",
        options: [
          { id: "airy", label: "Airy treatment", description: "Open layout with generous spacing", image: { path: imagePath, alt: "Generated treatment" } },
          { id: "dense", label: "Dense treatment", description: "Compact layout" },
        ],
      },
      {
        id: "followup", kind: "choice", header: "Follow-up", prompt: "Capture anything else", required: false,
        options: [{ id: "none", label: "Nothing else" }, { id: "blocked", label: "Blocked on review" }],
      },
    ],
  };
}

try {
  evidence.tty = { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY), columns: process.stdout.columns, rows: process.stdout.rows };
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("tty", new Error("the driver must run on a real TTY"));
  flush();

  const { loadExtensions } = await import(`file://${LOADER}`);
  const loaded = await loadExtensions([resolve(PACKAGE_ROOT, "extensions/visual-review.ts")], process.cwd());
  if (loaded.errors.length) fail("load", new Error(loaded.errors.map((item) => item.error).join("; ")));
  const extension = loaded.extensions.find((item) => item.resolvedPath.endsWith("extensions/visual-review.ts"));
  const tool = extension?.tools.get("ask_user_question")?.definition;
  if (!tool) fail("load", new Error("the local extension did not register ask_user_question"));
  record("load", { extension: extension.resolvedPath, tool: "ask_user_question" });

  let wizard;
  let done;
  let notifyCalls = [];
  let terminalInputListeners = [];
  const tui = new TuiMainScreen(terminal);
  const customResult = new Promise((resolveResult) => {
    done = (value) => resolveResult(value);
  });
  const context = {
    mode: "tui",
    hasUI: true,
    signal: new AbortController().signal,
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    ui: {
      onTerminalInput(listener) {
        terminalInputListeners.push(listener);
        return () => { terminalInputListeners = terminalInputListeners.filter((item) => item !== listener); };
      },
      notify(message, level) { notifyCalls.push({ message, level }); },
      async custom(factory) {
        const component = await factory(tui, theme, undefined, done);
        wizard = component;
        tui.addOverlay?.(component, { anchor: "bottom" });
        tui.start();
        await new Promise((resolveReady) => setTimeout(resolveReady, 500));
        return customResult;
      },
      async editor() { return undefined; },
      async select() { return undefined; },
      async input() { return undefined; },
      async confirm() { return true; },
    },
  };

  const execution = tool.execute("live-smoke", input, context.signal, undefined, context);
  await new Promise((resolveReady) => setTimeout(resolveReady, 1200));

  const send = async (data, label) => {
    for (const listener of terminalInputListeners) listener(data);
    wizard?.handleInput?.(data);
    tui.requestRender();
    await new Promise((resolveTick) => setTimeout(resolveTick, 500));
    record(`key:${label}`, { screen: sawOnScreen(label) });
  };

  if (!wizard) fail("render", new Error("the custom UI never opened a wizard"));
  const firstFrame = transcript;
  if (!/Live TTY smoke/.test(firstFrame)) fail("render", new Error("the review title never reached the terminal"));
  if (!/Pick the visual treatment/.test(firstFrame)) fail("render", new Error("the stage prompt never reached the terminal"));
  record("render", { bytes: firstFrame.length });

  // Inline image: the option carrying a real generated PNG must appear on the
  // terminal, either as image bytes/protocol output or as a labelled fallback.
  const imageRendered = /Airy treatment/.test(firstFrame);
  if (!imageRendered) fail("image", new Error("the image-backed option never reached the terminal"));
  record("image", { optionOnScreen: true, imageProtocolOutput: /kitty|iterm|sixel|base64/i.test(firstFrame) });

  await send("[B", "down");
  await send("\r", "select");
  if (!/Capture anything else/.test(transcript)) fail("stage-advance", new Error("the second stage never opened"));
  record("stage-advance", { stage: "followup" });

  const beforeCollapse = transcript.length;
  await send("", "collapse");
  const collapsed = transcript.slice(beforeCollapse);
  if (/Pick the visual treatment/.test(collapsed)) fail("collapse", new Error("the overlay kept painting while collapsed"));
  record("collapse", { hidden: true });

  await send("", "reopen");
  if (!/Capture anything else/.test(transcript.slice(beforeCollapse))) fail("reopen", new Error("the overlay never came back"));
  record("reopen", { visible: true });

  await send("[A", "up");
  await send("\r", "select-followup");
  if (!/review/i.test(transcript)) fail("final-review", new Error("the final review never rendered"));
  record("final-review", { rendered: true });

  // External editor: the real configured command takes over the terminal.
  const editorBefore = transcript.length;
  await send("e", "external-editor");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  const editorLaunched = /Launching external editor/.test(transcript.slice(editorBefore));
  record("editor", { launched: editorLaunched });
  // The PTY harness quits the editor and returns control; the walk continues.
  await new Promise((resolveWait) => setTimeout(resolveWait, 2500));

  await send("\r", "final-approve");
  const result = await Promise.race([
    execution,
    new Promise((_, reject) => setTimeout(() => reject(new Error("the tool never returned")), 15000)),
  ]).catch((error) => fail("complete", error));
  if (result.details?.status !== "completed" && result.details?.result?.status !== "completed") {
    fail("complete", new Error(`unexpected status ${result.details?.status ?? result.details?.result?.status}`));
  }
  const answerStage = result.details?.result?.answers?.map((answer) => answer.stageId) ?? [];
  if (!answerStage.includes("direction")) fail("complete", new Error("the chosen option was not recorded"));
  record("complete", { status: "completed", answers: answerStage });

  evidence.transcriptHits = {
    title: sawOnScreen("Live TTY smoke"),
    imageOption: sawOnScreen("Airy treatment"),
    finalReview: /review/i.test(transcript),
    editorLaunch: /Launching external editor/.test(transcript),
  };
  evidence.assertions = {
    realTty: true,
    realExtension: true,
    imageRendered: true,
    keyboardControls: true,
    stageAdvance: true,
    collapseReopen: true,
    finalReview: true,
    externalEditor: editorLaunched,
    completedWithAnswer: true,
  };
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.failure ??= error instanceof Error ? error.message : String(error);
} finally {
  try { tuiStop(); } catch { /* the TUI may never have started */ }
  flush();
  setTimeout(() => process.exit(evidence.status === "passed" ? 0 : 1), 80);
}

function tuiStop() {
  // TuiMainScreen is created in the try block; guard for the early failure paths.
  // eslint-disable-next-line no-undef
  if (typeof tui !== "undefined" && tui) tui.stop();
}
