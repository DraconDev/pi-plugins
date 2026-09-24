#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const required = [
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
  const info = await stat(new URL(path, root));
  assert.ok(info.isFile(), `${path} must be a file`);
  assert.ok(info.size > 0, `${path} must not be empty`);
}

const text = await readFile(new URL("tests/fixtures/tui-smoke.txt", root), "utf8");
assert.match(text, /TUI evidence/);
assert.match(text, /Tiny checked-in fixture/);
const png = await readFile(new URL("tests/fixtures/tui-smoke.png", root));
assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.ok(png.length > 1000, "visual evidence PNG must contain rendered content");

const checks = [
  ["npm test", ["npm", "test"]],
  ["npm run smoke:tui", ["npm", "run", "smoke:tui"]],
  ["npm run smoke:runtime", ["npm", "run", "smoke:runtime"]],
  ["npm run verify:activation", ["npm", "run", "verify:activation"]],
];
for (const [name, command] of checks) {
  const result = spawnSync(command[0], command.slice(1), { cwd: new URL(".", root), stdio: "inherit" });
  assert.equal(result.status, 0, `${name} failed`);
}

console.log("check: PASS");
