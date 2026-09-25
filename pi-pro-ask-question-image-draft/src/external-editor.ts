import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TUI } from "@earendil-works/pi-tui";

/** Run Pi's configured external editor without losing the current TUI lifecycle. */
export async function editWithExternalEditor(tui: TUI, command: string, value: string): Promise<string> {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("External editor command is empty");
  const [editor, ...args] = trimmed.split(/\s+/);
  if (!editor) throw new Error("External editor command is empty");

  const directory = await mkdtemp(join(tmpdir(), "pi-visual-review-"));
  const file = join(directory, "answer.md");
  let stopped = false;
  try {
    await writeFile(file, value, "utf8");
    tui.stop();
    stopped = true;
    process.stdout.write(`Launching external editor: ${trimmed}\nPi will resume when the editor exits.\n`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [...args, file], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`External editor exited with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`));
      });
    });
    return (await readFile(file, "utf8")).replace(/\r?\n$/, "");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (stopped) {
      tui.start();
      tui.requestRender(true);
    }
  }
}
