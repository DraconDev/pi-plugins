#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const compiler = [
  process.env.TSC,
  resolve(root, "node_modules/typescript/bin/tsc"),
  "/home/dracon/Dev/pi-plugins/pi-goal-list-loop-audit/node_modules/typescript/bin/tsc",
  "/home/dracon/Dev/pi-plugins/pi-codebuddy-sdk/node_modules/typescript/bin/tsc",
].filter(Boolean).find((candidate) => existsSync(candidate));
assert.ok(compiler, "No TypeScript compiler found. Install the package's dev dependency or set TSC=/path/to/tsc.");

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
assert.match(text, /Tiny checked-in fixture/);
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
