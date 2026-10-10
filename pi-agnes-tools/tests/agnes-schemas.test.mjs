
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
    const sizeSet = new Set((props.size.anyOf || []).map((s) => s.const));
    assert.deepEqual([...sizeSet].sort(), ["1K", "2K", "3K", "4K"]);
    // ratio: 1:1, 3:4, 4:3, 2:3, 3:2, 9:16, 16:9, 21:9 (use set compare to avoid
    // lex-vs-numeric sort surprises with '16:9' vs '1:1' etc.)
    const ratioSet = new Set((props.ratio.anyOf || []).map((s) => s.const));
    const expectedRatios = new Set(["1:1", "16:9", "2:3", "21:9", "3:2", "3:4", "4:3", "9:16"]);
    assert.equal(ratioSet.size, expectedRatios.size, "ratio has 8 options");
    for (const r of expectedRatios) assert.ok(ratioSet.has(r), "ratio has " + r);
    // and they are still optional (not in `required`)
    assert.ok(!image.parameters.required.includes("size"), "size optional");
    assert.ok(!image.parameters.required.includes("ratio"), "ratio optional");
  });
});
