import { register } from "node:module";
import { readFileSync } from "node:fs";
register("./hooks.mjs", import.meta.url);

const { default: registerExtension } = await import("../extensions/agnes-tools.ts");
const providers = {};
registerExtension({
  registerTool: () => {},
  registerProvider: (id, def) => { providers[id] = def; },
  on: () => {},
});

// Exact current on-disk state: stale single-model cache, no network (session_start path)
const store = JSON.parse(readFileSync("/home/dracon/.pi/agent/models-store.json", "utf8"));
const stored = { models: store["agnes"] ? store["agnes"].models : undefined };
console.log("stored:", (stored.models || []).map((m) => m.id).join(", "));

const models = await providers["agnes"].refreshModels({
  signal: undefined,
  stored,
  publish: async () => {},
  allowNetwork: false,
  credential: undefined,
});
console.log("refreshed (no network):", models.map((m) => m.id).join(", "));
console.log("has 3.0-flash:", models.some((m) => m.id === "agnes-3.0-flash"));
