#!/usr/bin/env node
import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";

import { parseArgs } from "./common.mjs";
import { detectImage } from "./images.mjs";
import { readFile } from "node:fs/promises";

export async function liveSmokePreconditions({ image, stdinIsTTY, stdoutIsTTY, editor }) {
  if (!image) throw new Error("--image <path> is required.");
  if (!stdinIsTTY || !stdoutIsTTY) throw new Error("Live smoke requires a real interactive TTY on stdin and stdout.");
  if (typeof editor !== "string" || !editor.trim()) throw new Error("Live smoke requires Pi's configured external editor; none is configured.");
  await access(resolve(image), constants.R_OK);
  const detected = detectImage(await readFile(resolve(image)));
  return { image: resolve(image), editor, tty: true, ...detected };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { image: "string" });
  let editor = process.env.PI_BENCHMARK_EDITOR?.trim();
  if (!editor) {
    try {
      const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
      editor = SettingsManager.create(process.cwd(), undefined, { projectTrusted: true }).getExternalEditorCommand();
    } catch {
      editor = "";
    }
  }
  const evidence = await liveSmokePreconditions({ image: args.image, stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY), editor });
  throw new Error(`Live preconditions passed, but this implementation pass has no interactive review driver; refusing to fake a live pass (${JSON.stringify(evidence)}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`smoke:live: ${error.message}\n`); process.exitCode = 1; });
}
