/**
 * Editor resolution and quit sequences for the real-TTY live gate.
 *
 * The gate has to be reproducible: the same command must produce the same
 * outcome on a fresh machine and on a re-run. Two things broke that before.
 *
 * 1. The editor was taken from `$EDITOR` when the caller's shell happened to
 *    export one, so the gate passed on one workstation and failed on another
 *    for a reason that had nothing to do with the package. Resolution now
 *    follows Pi's own order (settings `externalEditor`, then `$VISUAL`/`$EDITOR`,
 *    then Pi's default), records which source answered, and verifies the binary
 *    actually exists before the walk starts.
 * 2. The driver sent a hard-coded `ctrl+q` to leave the editor, which is
 *    micro's key and nothing else's, so a correctly resolved nano or vi run died
 *    with the editor still open. The quit sequence is now derived from the
 *    resolved command.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Pi's own resolution order, in the order Pi applies it. */
export function editorCandidates({ settingsEditor, visual, editor, platform = process.platform, defaultEditor = "nano" } = {}) {
  return [
    { source: "settings.externalEditor", command: typeof settingsEditor === "string" ? settingsEditor.trim() : "" },
    { source: "VISUAL", command: visual?.trim() ?? "" },
    { source: "EDITOR", command: editor?.trim() ?? "" },
    { source: "pi-default", command: platform === "win32" ? "notepad" : defaultEditor },
  ].filter((candidate) => candidate.command);
}

/** Absolute path of an executable on PATH, or null. */
export function whichExecutable(command, { env = process.env } = {}) {
  const binary = command.trim().split(/\s+/)[0];
  if (!binary) return null;
  const candidates = binary.includes("/") || isAbsolute(binary)
    ? [binary]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, binary));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The editor Pi would actually launch, with the source that answered and
 * whether it is runnable. No bespoke override variable: a recorded run must show
 * the same editor Pi itself resolves.
 */
export function resolveEditorCommand({ settingsEditor, visual, editor, env = process.env, platform = process.platform, settingsReader } = {}) {
  const resolved = settingsReader ? settingsReader() : settingsEditor;
  for (const candidate of editorCandidates({ settingsEditor: resolved, visual, editor, env, platform })) {
    const executable = whichExecutable(candidate.command, { env });
    return { ...candidate, executable, runnable: Boolean(executable) };
  }
  return { source: "none", command: "", executable: null, runnable: false };
}

/** Editors the gate can provision itself, in preference order. */
export const PROVISIONABLE_EDITORS = Object.freeze(["micro", "nano", "vi", "vim", "nvim", "ed"]);

/**
 * How to leave a real editor session: the quit keys, and the answer to give if
 * the editor then asks whether to save a modified buffer.
 */
const QUIT_SEQUENCES = {
  micro: { quit: ["ctrl+q"], save: "y", label: "micro" },
  nano: { quit: ["ctrl+x"], save: "y", label: "nano" },
  vi: { quit: [":q!", "enter"], save: null, label: "vi" },
  vim: { quit: [":q!", "enter"], save: null, label: "vim" },
  nvim: { quit: [":q!", "enter"], save: null, label: "nvim" },
  ed: { quit: ["ctrl+q"], save: null, label: "ed" },
};

export function quitSequenceFor(command) {
  const binary = (command ?? "").trim().split(/\s+/)[0] ?? "";
  const name = binary.split("/").pop()?.toLowerCase() ?? "";
  const known = QUIT_SEQUENCES[name];
  if (known) return { ...known, known: true };
  // An unknown editor still has to be quit, and "ctrl+c" is the only sequence
  // every line editor honours. Recorded as unknown so the evidence is honest
  // about which keys were sent.
  return { quit: ["ctrl+c"], save: "n", label: name || "unknown", known: false };
}
