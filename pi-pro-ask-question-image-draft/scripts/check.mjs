#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile, rm, mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
// `typescript` is a devDependency, so a clean clone has it in `node_modules`
// like anything else. It used to resolve only from `TSC` or from two hardcoded
// absolute paths in sibling projects on one machine, which means `npm run check`
// - the gate the README calls hermetic - died on its first line anywhere else,
// and `npm install` could never fix it because no dependency was declared to
// install.
const compiler = [
  process.env.TSC,
  resolve(root, "node_modules/typescript/bin/tsc"),
].filter(Boolean).find((candidate) => existsSync(candidate));
assert.ok(compiler, "No TypeScript compiler found. Run `npm install` (typescript is a devDependency) or set TSC=/path/to/tsc.");

const tsc = spawnSync(process.execPath, [compiler, "--noEmit", "-p", resolve(root, "tsconfig.json")], { stdio: "inherit" });
assert.equal(tsc.status, 0, "TypeScript check failed");

const required = [
  "tsconfig.json",
  "src/tui.ts",
  "src/schema.ts",
  "src/state.ts",
  "src/envelope.ts",
  "src/image-loader.ts",
  "extensions/visual-review.ts",
  "tests/visual-review.test.mjs",
  "tests/tui.test.mjs",
  "tests/fixtures/tiny.png",
  "tests/fixtures/tui-smoke.txt",
  "tests/fixtures/tui-smoke.png",
];
for (const path of required) {
  const info = await stat(resolve(root, path));
  assert.ok(info.isFile(), `${path} must be a file`);
  assert.ok(info.size > 0, `${path} must not be empty`);
}

const text = await readFile(resolve(root, "tests/fixtures/tui-smoke.txt"), "utf8");
assert.match(text, /TUI evidence/);
assert.match(text, /Choose a layout/);
// The fixture has to be *reproducible*, not merely present. It was asserted on
// with a string - `Tiny checked-in fixture` - that the generator stopped
// emitting, so the gate stayed green on a stale artifact while the documented
// regeneration step turned it red. Regenerating into a temporary file and
// comparing is the check that cannot go stale again: change the panel and this
// fails until the evidence is refreshed with it.
const scratch = await mkdtemp(resolve(tmpdir(), "pi-tui-evidence-"));
try {
  const regenerated = resolve(scratch, "tui-smoke.txt");
  const result = spawnSync(process.execPath, [resolve(root, "scripts/render-tui-evidence.mjs"), regenerated], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `regenerating the TUI evidence failed: ${result.stderr}`);
  const fresh = await readFile(regenerated, "utf8");
  assert.equal(
    fresh,
    text,
    "tests/fixtures/tui-smoke.txt no longer matches what the shipped generator produces. "
    + "Run `node scripts/render-tui-evidence.mjs && python3 scripts/render-tui-evidence.py`.",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
const png = await readFile(resolve(root, "tests/fixtures/tui-smoke.png"));
assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.equal(png.readUInt32BE(16), 1800, "visual evidence PNG width changed unexpectedly");
assert.ok(png.readUInt32BE(20) > 500, "visual evidence PNG must contain a rendered layout");
assert.ok(png.length > 1000, "visual evidence PNG must contain rendered content");

const checks = [
  ["npm test", ["npm", "test"]],
  ["npm run smoke:tui", ["npm", "run", "smoke:tui"]],
  ["npm run smoke:runtime", ["npm", "run", "smoke:runtime"]],
];
if (process.env.PI_VERIFY_ACTIVATION === "1") {
  checks.push(["npm run verify:activation", ["npm", "run", "verify:activation"]]);
}
for (const [name, command] of checks) {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, stdio: "inherit" });
  assert.equal(result.status, 0, `${name} failed`);
}

console.log("check: PASS");
