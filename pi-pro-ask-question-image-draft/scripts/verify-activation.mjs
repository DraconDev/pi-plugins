#!/usr/bin/env node
/**
 * Post-activation gate.
 *
 * This only passes when the local package is *already* active. It never changes
 * settings. When the local package is not active it reports `status:
 * "not_run"` and exits 0, because an unmet release gate means activation must
 * not have happened - that is the correct state, not a failure to hide.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const settingsPath = resolve(process.env.PI_SETTINGS_PATH ?? "/home/dracon/.pi/agent/settings.json");
const pluginPath = resolve(process.env.PI_PLUGIN_PATH ?? new URL("..", import.meta.url).pathname);
const beforePath = resolve(process.env.PI_SETTINGS_BEFORE_PATH ?? "/home/dracon/.pi/agent/settings.before-pi-visual-review.json");
const expectedPackage = pluginPath;
const superseded = "npm:@juicesharp/rpiv-ask-user-question";

const settings = JSON.parse(await readFile(settingsPath, "utf8"));
assert.ok(Array.isArray(settings.packages), "settings.packages must be an array");

const active = settings.packages.includes(expectedPackage);
if (!active) {
  process.stdout.write(`${JSON.stringify({
    status: "not_run",
    reason: "the local package is not activated",
    settingsPath,
    pluginPath,
    supersededStillActive: settings.packages.includes(superseded),
  }, null, 2)}\n`);
  process.exit(0);
}

assert.ok(!settings.packages.includes(superseded), "the superseded package must be absent");
assert.equal(settings.packages.filter((entry) => entry === expectedPackage).length, 1, "the local package must occur exactly once");

const before = JSON.parse(await readFile(beforePath, "utf8"));
const beforeUnrelated = structuredClone(before);
const afterUnrelated = structuredClone(settings);
beforeUnrelated.packages = beforeUnrelated.packages.filter((entry) => entry !== superseded);
afterUnrelated.packages = afterUnrelated.packages.filter((entry) => entry !== expectedPackage);
assert.deepEqual(afterUnrelated, beforeUnrelated, "unrelated settings entries changed");

const { loadExtensions } = await import("/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
const loaded = await loadExtensions([resolve(pluginPath, "extensions/visual-review.ts")], process.cwd());
assert.equal(loaded.errors.length, 0, `extension loader errors: ${JSON.stringify(loaded.errors)}`);
const extension = loaded.extensions.find((item) => item.resolvedPath.endsWith("/extensions/visual-review.ts"));
assert.ok(extension, "the local extension was not loaded");
const tools = [...extension.tools.keys()];
assert.deepEqual(tools, ["ask_user_question"]);
const tool = extension.tools.get("ask_user_question")?.definition;
assert.equal(tool?.description.includes("staged visual review"), true);
assert.equal(tool?.parameters?.type, "object");
assert.equal(tool?.executionMode, "sequential");
process.stdout.write(`${JSON.stringify({ status: "passed", settingsPath, pluginPath, tools, loaderErrors: loaded.errors.length, unrelatedSettingsPreserved: true }, null, 2)}\n`);
