#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const settingsPath = resolve(process.env.PI_SETTINGS_PATH ?? "/home/dracon/.pi/agent/settings.json");
const pluginPath = resolve(process.env.PI_PLUGIN_PATH ?? new URL("..", import.meta.url).pathname);
const beforePath = resolve(process.env.PI_SETTINGS_BEFORE_PATH ?? "/home/dracon/.pi/agent/settings.before-pi-visual-review.json");
const expectedPackage = pluginPath;

const settingsText = await readFile(settingsPath, "utf8");
const settings = JSON.parse(settingsText);
assert.ok(Array.isArray(settings.packages), "settings.packages must be an array");
assert.ok(settings.packages.includes(expectedPackage), "settings must activate the local pi-visual-review package");
assert.ok(!settings.packages.includes("npm:@juicesharp/rpiv-ask-user-question"), "the superseded package must be absent");
assert.equal(settings.packages.filter((entry) => entry === expectedPackage).length, 1, "the local package must occur exactly once");

const beforeText = await readFile(beforePath, "utf8");
const before = JSON.parse(beforeText);
const beforeUnrelated = structuredClone(before);
const afterUnrelated = structuredClone(settings);
beforeUnrelated.packages = beforeUnrelated.packages.filter((entry) => entry !== "npm:@juicesharp/rpiv-ask-user-question");
afterUnrelated.packages = afterUnrelated.packages.filter((entry) => entry !== expectedPackage);
assert.deepEqual(afterUnrelated, beforeUnrelated, "unrelated settings entries changed");

const { loadExtensions } = await import("/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
const loaded = await loadExtensions([pluginPath], process.cwd());
assert.equal(loaded.errors.length, 0, `extension loader errors: ${JSON.stringify(loaded.errors)}`);
const extension = loaded.extensions.find((item) => item.resolvedPath.endsWith("/extensions/visual-review.ts"));
assert.ok(extension, "the local extension was not loaded");
const tools = [...extension.tools.keys()];
assert.deepEqual(tools, ["ask_user_question"]);
const tool = extension.tools.get("ask_user_question");
assert.equal(tool?.description.includes("staged visual review"), true);
assert.equal(tool?.parameters?.type, "object");
assert.equal(tool?.executionMode, "sequential");
console.log(JSON.stringify({ settingsPath, pluginPath, tools, loaderErrors: loaded.errors.length }, null, 2));
