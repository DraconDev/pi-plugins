
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

  it("agnes_image exposes optional size and ratio for native widescreen", () => {
    const tools = loadTools();
    const image = tools.find((t) => t.name === "agnes_image");
    assert.ok(image, "agnes_image tool is registered");
    const props = image.parameters.properties;
    assert.ok(props.size, "size property present");
    assert.ok(props.ratio, "ratio property present");
    // size: 1K/2K/3K/4K -> Type.Union of Type.Literal -> { anyOf: [{const: ...}, ...] }
    const sizeConsts = (props.size.anyOf || []).map((s) => s.const).sort();
    assert.deepEqual(sizeConsts, ["1K", "2K", "3K", "4K"]);
    // ratio: 1:1, 3:4, 4:3, 2:3, 3:2, 9:16, 16:9, 21:9
    const ratioConsts = (props.ratio.anyOf || []).map((s) => s.const).sort();
    assert.deepEqual(
      ratioConsts,
      ["1:1", "16:9", "2:3", "21:9", "3:2", "3:4", "4:3", "9:16"]
    );
    // and they are still optional (not in `required`)
    assert.ok(!image.parameters.required.includes("size"), "size optional");
    assert.ok(!image.parameters.required.includes("ratio"), "ratio optional");
  });
});
