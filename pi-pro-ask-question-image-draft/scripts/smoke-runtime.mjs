#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadExtensions } from "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const pluginPath = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = resolve(pluginPath, "extensions/visual-review.ts");
const loaded = await loadExtensions([extensionPath], process.cwd());
assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
const extension = loaded.extensions.find((item) => item.resolvedPath.endsWith("/extensions/visual-review.ts"));
assert.ok(extension);
const names = [...extension.tools.keys()];
assert.deepEqual(names, ["ask_user_question"]);
const tool = extension.tools.get("ask_user_question");
assert.equal(tool?.executionMode, "sequential");
assert.equal(tool?.parameters?.type, "object");
assert.match(tool?.description ?? "", /staged visual review/);
console.log(JSON.stringify({ extension: extension.resolvedPath, tools: names }, null, 2));
