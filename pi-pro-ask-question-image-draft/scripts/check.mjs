#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const candidates = [
  process.env.TSC,
  resolve(root, "node_modules/typescript/bin/tsc"),
  "/home/dracon/Dev/pi-plugins/pi-goal-list-loop-audit/node_modules/typescript/bin/tsc",
  "/home/dracon/Dev/pi-plugins/pi-codebuddy-sdk/node_modules/typescript/bin/tsc",
].filter(Boolean);
const compiler = candidates.find((candidate) => existsSync(candidate));
if (!compiler) {
  console.error("No TypeScript compiler found. Install the package's dev dependency or set TSC=/path/to/tsc.");
  process.exit(127);
}
const result = spawnSync(process.execPath, [compiler, "--noEmit", "-p", resolve(root, "tsconfig.json")], { stdio: "inherit" });
process.exit(result.status ?? 1);
