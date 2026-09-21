
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);

const { default: registerExtension } = await import("../extensions/agnes-tools.ts");

function loadTools() {
  const tools = [];
  registerExtension({
    registerTool: (t) => tools.push(t),
    registerProvider: () => {},
    on: () => {},
  });
  return tools;
}

describe("agnes tool schemas", () => {
  it("agnes_image requires only prompt", () => {
    const tools = loadTools();
    const image = tools.find((t) => t.name === "agnes_image");
    assert.ok(image, "agnes_image tool is registered");
    assert.deepEqual(image.parameters.required, ["prompt"]);
  });

  it("agnes_video requires only prompt", () => {
    const tools = loadTools();
    const video = tools.find((t) => t.name === "agnes_video");
    assert.ok(video, "agnes_video tool is registered");
    assert.deepEqual(video.parameters.required, ["prompt"]);
  });
});
