#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(import.meta.dirname, "..");
const generatedConfig = join(packageRoot, ".tsconfig.typecheck.generated.json");

function findPiPackageRoot() {
  const which = spawnSync("which", ["pi"], { encoding: "utf8" });
  const executable = which.status === 0 ? which.stdout.trim() : "";
  if (!executable) return undefined;

  let current = dirname(realpathSync(executable));
  while (true) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent") return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

const piRoot = findPiPackageRoot();
if (!piRoot) {
  console.error("Could not locate the host @earendil-works/pi-coding-agent package via `which pi`.");
  process.exit(1);
}

const requireFromPi = createRequire(join(piRoot, "package.json"));
let piAiCompat;
try {
  piAiCompat = requireFromPi.resolve("@earendil-works/pi-ai/compat");
} catch {
  piAiCompat = join(piRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js");
}
if (piAiCompat.endsWith(".js")) {
  piAiCompat = `${piAiCompat.slice(0, -3)}.d.ts`;
}
if (!existsSync(piAiCompat)) {
  console.error(`Could not locate Pi's host pi-ai compatibility declarations: ${piAiCompat}`);
  process.exit(1);
}

const config = {
  extends: "./tsconfig.json",
  compilerOptions: {
    paths: {
      "@earendil-works/pi-coding-agent": [join(piRoot, "dist/index.d.ts")],
      "@earendil-works/pi-ai": [piAiCompat],
    },
  },
};

writeFileSync(generatedConfig, `${JSON.stringify(config, null, 2)}\n`);
let result;
try {
  result = spawnSync(
    "npx",
    ["-p", "typescript", "tsc", "--noEmit", "-p", generatedConfig],
    { cwd: packageRoot, stdio: "inherit" },
  );
} finally {
  rmSync(generatedConfig, { force: true });
}
process.exit(result?.status ?? 1);
