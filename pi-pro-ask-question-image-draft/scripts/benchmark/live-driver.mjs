#!/usr/bin/env node
/**
 * Real-TTY interactive driver for the live smoke.
 *
 * The smallest honest Pi host: it loads the *real* local extension through Pi's
 * own extension loader, runs the real tool in `tui` mode on a real pi-tui screen
 * inside a real pseudo-terminal, and lets the PTY harness send real keypresses
 * through the terminal. Assertions are made against the bytes the screen actually
 * painted and the real wizard/overlay state, so a pass cannot be fabricated.
 *
 * Expected key walk (sent by live-pty.py): down, enter, Ctrl+], Ctrl+], up,
 * enter, e, (editor quit), enter.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getCapabilities, ProcessTerminal, setCapabilities, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../..");
const LOADER = process.env.PI_BENCHMARK_LOADER
  ?? "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

/** Accepts both `--flag=value` and `--flag value` so the harness can pass
 * arguments either way without a bare flag silently becoming "true". */
const args = new Map();
{
  const tokens = process.argv.slice(2);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) continue;
    const [key, ...rest] = token.replace(/^--/, "").split("=");
    if (rest.length) { args.set(key, rest.join("=")); continue; }
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith("--")) { args.set(key, next); index += 1; continue; }
    args.set(key, "true");
  }
}
const imagePath = resolve(args.get("image") ?? "");
const outPath = resolve(args.get("out") ?? "/tmp/live-smoke-evidence.json");
const keysPath = resolve(args.get("keys") ?? "/tmp/live-smoke-keys.json");
const deadline = Date.now() + Number(args.get("timeout") ?? 120) * 1000;

const evidence = { kind: "live-tty-smoke", tty: {}, steps: [], errors: {}, assertions: {}, observed: {} };
const flush = () => writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
const record = (step, detail = {}) => { evidence.steps.push({ step, ...detail }); flush(); };
/**
 * The driver decides *what* to press; the PTY harness supplies the real key
 * bytes. This queue is the only channel between them, so every keypress still
 * travels through the real terminal.
 */
let queued = [];
let nextKeyId = 1;
// Atomic: the harness polls this file, so a partial write would drop keys.
const writeKeys = () => {
  const temporary = `${keysPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ queued })}\n`);
  renameSync(temporary, keysPath);
};
// Monotonic ids let the harness send every key exactly once even though both
// sides rewrite this file.
const requestKey = (data, why) => {
  queued.push({ id: nextKeyId++, data, why });
  writeKeys();
  evidence.observed.requests = [...(evidence.observed.requests ?? []), `${nextKeyId - 1}:${why}`];
  flush();
};
const fail = (step, error) => {
  const message = error instanceof Error ? error.message : String(error);
  evidence.errors[step] = message;
  evidence.failure = message;
  evidence.status = "failed";
  flush();
  setTimeout(() => process.exit(1), 80);
  throw error;
};

let transcript = "";
// A pseudo-terminal cannot answer the terminal's image-protocol probe, so the
// capability is pinned to the Kitty protocol. This exercises the real inline
// image path and lets the smoke assert that image bytes really reached the
// terminal, instead of silently accepting a text placeholder.
/**
 * The extension is loaded through jiti, which resolves `@earendil-works/pi-tui`
 * to the copy nested under the coding agent. A pseudo-terminal cannot answer the
 * image-protocol probe, so the capability is pinned on *every* copy in play.
 * This is the same inline-image code path a real terminal would take, and the
 * smoke below asserts the image bytes actually reach the terminal.
 */
const CAPABILITY_OVERRIDE = { images: "kitty", trueColor: true, hyperlinks: false };
const tuiModules = [await import("@earendil-works/pi-tui")];
try {
  tuiModules.push(await import("/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js"));
} catch { /* the nested copy is optional */ }
for (const module of tuiModules) module.setCapabilities(CAPABILITY_OVERRIDE);
const pinCapabilities = () => { for (const module of tuiModules) module.setCapabilities(CAPABILITY_OVERRIDE); };
const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal);
const originalWrite = terminal.write.bind(terminal);
terminal.write = (data) => { transcript += data; return originalWrite(data); };
// The external editor handoff writes straight to stdout, so mirror that too:
// the assertions below must read what the terminal actually received.
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => { transcript += String(chunk); return originalStdoutWrite(chunk, ...rest); };
const saw = (needle) => transcript.includes(needle);

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  dim: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  inverse: (text) => text,
};
const tick = (ms = 200) => new Promise((resolveTick) => setTimeout(resolveTick, ms));

const reviewInput = {
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

// Strip SGR, OSC-8 hyperlink, and cursor sequences before reading the screen.
const plain = (line) => line
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[@-Z\\-_]/g, "");

let overlayHandle;
let wizard;
// Live paint from the same component the TUI renders.
const frame = () => wizard.render(terminal.columns).join("\n");
const painted = (needle) => frame().includes(needle);
const waitFor = async (predicate, label, ms = 12000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await tick(120);
  }
  fail(label, new Error(`timed out waiting for ${label}`));
  return false;
};
try {
  evidence.argv = process.argv.slice(2);
  evidence.parsedArgs = Object.fromEntries(args);
  evidence.imagePath = imagePath;
  evidence.tty = { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY), columns: terminal.columns, rows: terminal.rows };
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("tty", new Error("the live driver must run on a real TTY"));
  flush();

  const { createExtensionRuntime, loadExtensions } = await import(`file://${LOADER}`);
  // The real runtime, with the one action the tool needs bound to this session.
  const runtime = createExtensionRuntime();
  const runtimeEntries = [];
  runtime.appendEntry = (type, data) => { runtimeEntries.push({ type, data }); };
  runtime.refreshTools = () => {};
  runtime.getActiveTools = () => [];
  runtime.getAllTools = () => [];
  const loaded = await loadExtensions([resolve(PACKAGE_ROOT, "extensions/visual-review.ts")], process.cwd(), undefined, runtime);
  if (loaded.errors.length) fail("load", new Error(loaded.errors.map((item) => item.error).join("; ")));
  const extension = loaded.extensions.find((item) => item.resolvedPath.endsWith("extensions/visual-review.ts"));
  const tool = extension?.tools.get("ask_user_question")?.definition;
  if (!tool) fail("load", new Error("the local extension did not register ask_user_question"));
  record("load", { extension: extension.resolvedPath, tool: "ask_user_question" });

  // Pi's own keybinding manager, so the external-editor key is the real one.
  const { KeybindingsManager } = await import("/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");
  const keybindings = KeybindingsManager.create();
  setKeybindings(keybindings);
  const externalKeys = keybindings.getKeys("app.editor.external");
  record("keybindings", { externalEditorKeys: externalKeys, keybindingsSource: "pi-tui defaults" });
  const sessionEntries = [];
  const notifications = [];
  const inputListeners = [];
  let finish;
  const finished = new Promise((resolveDone) => { finish = resolveDone; });
  const context = {
    mode: "tui",
    hasUI: true,
    signal: new AbortController().signal,
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => sessionEntries, getEntries: () => sessionEntries, getSessionFile: () => null },
    modelRegistry: { getApiKey: () => undefined, resolveModel: () => undefined },
    ui: {
      onTerminalInput(listener) {
        inputListeners.push(listener);
        return () => { const index = inputListeners.indexOf(listener); if (index >= 0) inputListeners.splice(index, 1); };
      },
      notify(message, level) { notifications.push({ message, level }); },
      /**
       * The real contract: the factory's component becomes an overlay, `onHandle`
       * hands back the real OverlayHandle, and raw stdin is forwarded to the
       * extension's terminal-input listeners.
       */
      async custom(factory, options = {}) {
        const component = await factory(tui, theme, keybindings, finish);
        wizard = component;
        overlayHandle = tui.showOverlay(component, typeof options.overlayOptions === "function" ? options.overlayOptions() : (options.overlayOptions ?? { anchor: "bottom-center", width: "100%", maxHeight: "100%" }));
        overlayHandle.focus();
        options.onHandle?.(overlayHandle);
        // Pi wires extension terminal input to *raw* stdin, so a hidden overlay
        // still receives Ctrl+]. tui.start() owns the focused path; this raw hook
        // only fires while the overlay is hidden, so no key is delivered twice.
        // Pi routes raw stdin to extension terminal-input listeners only while an
        // overlay is hidden; otherwise the TUI dispatches to the focused
        // component. Routing it the same way here keeps every keypress real and
        // delivers it exactly once.
        const terminalStart = terminal.start.bind(terminal);
        terminal.start = (onInput, onResize) => {
          terminalStart((data) => {
            if (overlayHandle.isHidden()) for (const listener of [...inputListeners]) listener(data);
            else onInput(data);
          }, onResize);
        };
        tui.start();
        overlayHandle.focus();
        await tick(900);
        record("overlay", { focused: overlayHandle.isFocused(), hidden: overlayHandle.isHidden() });
        return finished;
      },
      async editor() { return undefined; },
      async select() { return undefined; },
      async input() { return undefined; },
      async confirm() { return true; },
    },
  };

  const execution = tool.execute("live-smoke", reviewInput, context.signal, {
    appendEntry: (type, data) => { sessionEntries.push({ type, data }); runtimeEntries.push({ type, data }); },
  }, context);
  execution.catch((error) => fail("tool", error));
  await tick(1500);
  if (!wizard) fail("render", new Error("the custom UI never opened the review wizard"));

  if (!saw("Live TTY smoke")) fail("render", new Error("the review title never reached the terminal"));
  if (!saw("Pick the visual treatment")) fail("render", new Error("the stage prompt never reached the terminal"));
  if (!saw("Airy treatment")) fail("image", new Error("the image-backed option never reached the terminal"));
  {
    const probe = wizard.render(110);
    const imageLineIndex = probe.findIndex((line) => /\u001b_G|\u001b_@/.test(line));
    record("image-probe", {
      totalLines: probe.length,
      imageLineIndex,
      previewLines: probe.filter((line) => line.includes("Preview:")).length,
      altLines: probe.filter((line) => /Alt:|Image:/.test(line)).length,
      loadedEntry: (() => {
        const entry = wizard.loadedImages?.get("direction:airy");
        return entry ? { hasImage: Boolean(entry.image), error: entry.error ?? null, keys: Object.keys(entry) } : null;
      })(),
      nestedCaps: (await import("/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/terminal-image.js")).getCapabilities().images,
      directCaps: getCapabilities().images,
    });
  }
  // The wizard renders through the pi-tui copy that jiti resolved for the
  // extension, which can be a different module instance than this file's.
  const wizardTui = await import("/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js");
  wizardTui.setCapabilities(CAPABILITY_OVERRIDE);
  tuiModules.push(wizardTui);
  pinCapabilities();
  tui.requestRender(true);
  await tick(600);
  const caps = tuiModules.map((module) => module.getCapabilities());
  record("render", { bytes: transcript.length, columns: terminal.columns, capabilities: caps, imageProtocol: caps.map((item) => item.images) });

  let hiddenFrames = 0;
  const watcher = setInterval(() => { if (overlayHandle?.isHidden()) hiddenFrames += 1; }, 60);
  const seenKeys = [];
  const originalHandleInput = wizard.handleInput.bind(wizard);
  wizard.handleInput = (data) => { seenKeys.push(JSON.stringify(data)); return originalHandleInput(data); };
  const originalTerminalInput = wizard.handleTerminalInput.bind(wizard);
  wizard.handleTerminalInput = (data) => {
    const handled = originalTerminalInput(data);
    evidence.observed.terminalInput = [...(evidence.observed.terminalInput ?? []), `${JSON.stringify(data)}=${handled}`];
    flush();
    return handled;
  };
  const noteImageState = () => {
    const entry = wizard?.loadedImages?.get("direction:airy");
    evidence.observed.frameImage = /\u001b_G|\u001b_@/.test(frame());
    evidence.observed.wizard = wizard ? {
      imageMode: wizard.imageMode, loaded: wizard.loadedImages?.size ?? null,
      selected: wizard.selectedIndex, rowKind: wizard.currentRows?.()?.[wizard.selectedIndex]?.kind ?? null,
      hasImage: Boolean(entry?.image), error: entry?.error ?? null,
    } : null;
  };
  const heartbeat = setInterval(() => {
    noteImageState();
    evidence.observed.wizard = wizard ? { imageMode: wizard.imageMode, loaded: wizard.loadedImages?.size ?? null, keys: [...(wizard.loadedImages?.keys?.() ?? [])], selected: wizard.selectedIndex, rowKind: wizard.currentRows?.()?.[wizard.selectedIndex]?.kind ?? null, stageId: wizard.currentStage?.()?.id ?? null } : null;
    evidence.observed.frameHasPreview = frame().includes("Preview:");
    evidence.observed.keys = seenKeys;
    evidence.observed.overlay = overlayHandle ? { focused: overlayHandle.isFocused(), hidden: overlayHandle.isHidden() } : null;
    evidence.observed.listeners = inputListeners.length;
    evidence.observed.tail = transcript.slice(-160);
    flush();
  }, 1000);
  const timeoutGuard = setTimeout(() => fail("timeout", new Error(`the review never completed; keys=${JSON.stringify(seenKeys)}`)), Math.max(3000, deadline - Date.now()));

  // The inline image must really reach the terminal: protocol escape plus base64
  // payload. Image loading is asynchronous, so wait for the bytes.
  let payloadBytes = 0;
  let paintedPayload = 0;
  await waitFor(() => {
    // Force a repaint so the asynchronously loaded image reaches the terminal.
    tui.requestRender(true);
    payloadBytes = (transcript.match(/[A-Za-z0-9+/=]{200,}/g) ?? []).reduce((sum, chunk) => sum + chunk.length, 0);
    paintedPayload = (frame().match(/[A-Za-z0-9+/=]{200,}/g) ?? []).reduce((sum, chunk) => sum + chunk.length, 0);
    return payloadBytes >= 2000 || paintedPayload >= 2000;
  }, "image-bytes", 30000);
  if (payloadBytes < 2000) fail("image", new Error(`the inline image never reached the terminal (frame payload ${paintedPayload} bytes)`));
  record("image", { imageProtocol: "kitty", imagePayloadBytes: payloadBytes, imageOnTerminal: true });

  // The live render marks the active row with "> ". Navigation is driven from
  // what is actually on screen, not from a guessed row count.
  // What the *terminal* shows, including output from the external editor, which
  // never passes through this process's stdout.
  const screenPath = `${outPath}.screen`;
  const tailText = () => {
    try { return plain(readFileSync(screenPath, "utf8")); } catch { return ""; }
  };
  const tailTextPlain = (size = 2000) => plain(transcript.slice(-size));
  const activeRow = () => {
    for (const line of frame().split("\n").map(plain)) {
      const match = /(?:^|\s)>\s?(\S[^│]{0,48}?)\s{2,}/.exec(line) ?? /(?:^|\s)>\s?(\S.*)$/.exec(line);
      if (match) return match[1].trim();
    }
    return null;
  };
  const moveTo = async (rowText, label) => {
    const history = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = activeRow();
      history.push(current);
      if (current === rowText) return record("row", { label, row: current, moves: attempt });
      if (history.length > 2 && history.at(-1) === history.at(-3)) {
        fail(label, new Error(`row navigation wrapped without reaching "${rowText}"; frame=${JSON.stringify(frame().split("\n").filter((line) => line.trim()).slice(0, 8))}`));
      }
      const before = seenKeys.filter((key) => key.includes("[B")).length;
      requestKey("\u001b[B", `${label}: move down`);
      // The terminal is still flushing megabytes of inline image data, so key
      // delivery is asserted generously rather than on a tight timer.
      await waitFor(() => seenKeys.filter((key) => key.includes("[B")).length > before, `${label}-down-${attempt}`, 25000);
      await tick(200);
    }
    fail(label, new Error(`never reached the "${rowText}" row; active row is ${activeRow()}`));
  };
  // 1. Answer the image-backed stage with the real keyboard.
  await tick(1500);
  await moveTo("Dense treatment", "second-option");
  const beforeSelect = seenKeys.length;
  requestKey("\r", "select the treatment");
  await waitFor(() => seenKeys.length > beforeSelect, "select-key", 25000);
  await waitFor(() => !painted("Pick the visual treatment") && painted("Follow-up"), "stage-advance", 15000);
  record("stage-advance", { row: activeRow() });

  // 2. Collapse and reopen the overlay with the real Ctrl+] key.
  requestKey("\u001d", "collapse the overlay");
  await waitFor(() => hiddenFrames > 0, "collapse");
  record("collapse", { hiddenFrames });
  requestKey("\u001d", "reopen the overlay");
  await waitFor(() => overlayHandle.isHidden() === false, "reopen");
  record("reopen", { visible: true, row: activeRow() });

  // 3. Answer the optional follow-up stage, then open the final review.
  await moveTo("Nothing else", "follow-up-option");
  const beforeFollowUp = seenKeys.length;
  requestKey("\r", "answer the follow-up stage");
  await waitFor(() => seenKeys.length > beforeFollowUp, "follow-up-key", 25000);
  await tick(700);
  if (!painted("Approve review")) {
    // The review is the next stop in the stage cycle when the answer did not
    // advance there by itself.
    const beforeTabReview = seenKeys.length;
    requestKey("\t", "tab to the final review");
    await waitFor(() => seenKeys.length > beforeTabReview, "review-tab-key", 25000);
  }
  await waitFor(() => painted("Approve review"), "final-review", 15000);
  record("final-review", { row: activeRow() });

  // 4. Go back to the first stage through the review's "Edit answers" row and
  //    open the configured external editor from the custom-answer input.
  await moveTo("Edit answers", "edit-answers-row");
  const beforeEdit = seenKeys.length;
  requestKey("\r", "return to the stages");
  await waitFor(() => seenKeys.length > beforeEdit, "edit-key", 25000);
  await waitFor(() => painted("Pick the visual treatment"), "back-to-stage-one", 15000);
  record("back-to-stage-one", { row: activeRow() });

  const externalKey = externalKeys[0];
  if (!externalKey) fail("editor", new Error("no app.editor.external keybinding is defined"));
  await moveTo("Type something.", "other-row");
  const beforeOther = seenKeys.length;
  requestKey("\r", "open the custom answer editor");
  await waitFor(() => seenKeys.length > beforeOther, "other-key", 25000);
  await waitFor(() => painted("Enter to submit"), "custom-input-mode", 15000);
  record("custom-input", { key: externalKey });

  // 5. The configured external editor takes over the real terminal.
  requestKey(externalKey, "open the configured external editor");
  await waitFor(() => /Launching external editor/.test(transcript), "editor-launch", 25000);
  record("editor", { launched: true, key: externalKey });

  // Type inside the real editor, then save and quit it. The keys go through the
  // same pseudo-terminal, so this is a genuine editor session.
  // Close the real editor and hand the terminal back to the TUI. The frame
  // already says "Enter to submit" while the editor owns the terminal, so the
  // reliable signal that the editor has exited is Pi's own temp answer file
  // being removed after the editor process returns.
  // Only the directory this launch created matters: stale directories from
  // earlier runs must not make the editor look permanently open.
  const editorDirsBefore = new Set(readdirSync("/tmp").filter((entry) => entry.startsWith("pi-visual-review-")));
  const liveEditorDir = () => readdirSync("/tmp").find((entry) => entry.startsWith("pi-visual-review-")
    && !editorDirsBefore.has(entry) && existsSync(join("/tmp", entry, "answer.md")));
  requestKey("ctrl+q", "ask the editor to quit");
  // The editor may ask to save its buffer; answer the prompt the way a user
  // would, then wait for the editor process itself to return.
  await waitFor(() => /before closing|save changes/i.test(tailText()) || !liveEditorDir(), "editor-save-prompt", 30000);
  if (liveEditorDir()) {
    requestKey("n", "discard the editor buffer");
    await tick(800);
  }
  await waitFor(() => !liveEditorDir(), "editor-exited", 40000);
  record("editor-closed", { editorLaunched: true, editorProcessExited: true });
  await waitFor(() => painted("Enter to submit"), "back-from-editor", 20000);
  record("tui-resumed", { inputModeRestored: true });

  // Leave the custom-answer editor without changing the stage answer.
  const beforeEscape = seenKeys.length;
  requestKey("escape", "leave the custom answer editor");
  await waitFor(() => seenKeys.length > beforeEscape, "escape-key", 40000);
  await tick(600);

  // 6. Approve through the explicit final review action. Tab walks the stage
  //    cycle, so step onto the review screen first.
  for (let hop = 0; hop < 3 && !painted("Approve review"); hop += 1) {
    const beforeHop = seenKeys.length;
    requestKey("\t", "tab towards the final review");
    await waitFor(() => seenKeys.length > beforeHop, `review-hop-${hop}`, 25000);
    await tick(400);
  }
  await waitFor(() => painted("Approve review"), "review-screen", 25000);
  await moveTo("Approve review", "approve-row");
  const beforeApprove = seenKeys.length;
  requestKey("\r", "approve the review");
  await waitFor(() => seenKeys.length > beforeApprove, "approve-key", 25000);

  const result = await execution;
  clearTimeout(timeoutGuard);
  clearInterval(watcher);
  clearInterval(heartbeat);

  const status = result.details?.result?.status ?? result.details?.status;
  const answers = result.details?.result?.answers?.map((answer) => answer.stageId) ?? [];

  if (status !== "completed") fail("complete", new Error(`unexpected status ${status}`));
  if (!answers.includes("direction")) fail("complete", new Error("the chosen option was not recorded"));
  if (hiddenFrames === 0) fail("collapse", new Error("the overlay was never hidden"));
  if (!saw("Launching external editor")) fail("editor", new Error("the configured external editor never launched"));
  if (runtimeEntries.length === 0) fail("persistence", new Error("the tool persisted no review-state entry"));
  record("complete", { status, answers, hiddenFrames, keys: seenKeys.length, editorLaunched: true, persistedEntries: runtimeEntries.length });

  evidence.assertions = {
    realTty: true,
    realExtension: true,
    titleAndPromptOnScreen: true,
    imageRendered: true,
    keyboardControls: seenKeys.length >= 6,
    stageAdvance: true,
    collapseReopen: hiddenFrames > 0,
    finalReview: true,
    externalEditor: true,
    completedWithAnswer: answers.includes("direction"),
    persistence: runtimeEntries.length > 0,
  };
  evidence.observed = { keys: seenKeys, hiddenFrames, notifications, sessionEntries: sessionEntries.length, persistedEntries: runtimeEntries.length, transcriptBytes: transcript.length };
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.failure ??= error instanceof Error ? error.message : String(error);
} finally {
  try { tui.stop(); } catch { /* the screen may never have started */ }
  try { terminal.stop(); } catch { /* ignore */ }
  flush();
  setTimeout(() => process.exit(evidence.status === "passed" ? 0 : 1), 100);
}
