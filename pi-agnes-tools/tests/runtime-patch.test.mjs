/**
 * Runtime test for the patched agnes_image tool path.
 * Loads extensions/agnes-tools.ts with stubs, captures the registered tool,
 * and exercises the executeImage flow against the live Agnes API.
 *
 * Proves:
 *   1. Schema exposes size and ratio (also covered by agnes-schemas.test.mjs).
 *   2. executeImage forwards size and ratio into the request body.
 *   3. The Agnes API returns the expected non-square pixel dimensions.
 *   4. Default (no size/ratio) still returns 1024x1024 (regression guard).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

register("./hooks.mjs", import.meta.url);

const authPath = join(homedir(), ".pi", "agent", "auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf8"));
const agnesKey = auth.agnes && auth.agnes.key;
if (!agnesKey) {
  console.log("SKIP: no agnes key in " + authPath);
  process.exit(0);
}

async function loadTool() {
  const tools = [];
  const ext = (await import(pathToFileURL("../extensions/agnes-tools.ts").href)).default;
  ext({
    registerTool: (t) => tools.push(t),
    registerProvider: () => {},
    on: () => {},
  });
  const t = tools.find((x) => x.name === "agnes_image");
  if (!t) throw new Error("agnes_image tool not registered");
  return t;
}

function readPngDims(filePath) {
  const buf = readFileSync(filePath);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: statSync(filePath).size };
}

describe("agnes_image runtime — size/ratio patch", () => {
  it("2K + 16:9 returns 2624x1472", async () => {
    const t = await loadTool();
    const r = await t.execute("c1", {
      prompt: "lone girl under a streetlight in rain, anime, dark moody, cinematic, 16:9 composition",
      size: "2K",
      ratio: "16:9",
      response_format: "b64_json",
    });
    const { w, h, bytes } = readPngDims(r.details.filePath);
    console.log("  2K/16:9 file=" + r.details.filePath + " dims=" + w + "x" + h + " bytes=" + bytes);
    assert.equal(w, 2624, "width 2624");
    assert.equal(h, 1472, "height 1472");
  });

  it("1K + 9:16 returns 736x1312", async () => {
    const t = await loadTool();
    const r = await t.execute("c2", {
      prompt: "tall anime girl portrait, dark moody, vertical composition",
      size: "1K",
      ratio: "9:16",
      response_format: "b64_json",
    });
    const { w, h, bytes } = readPngDims(r.details.filePath);
    console.log("  1K/9:16 dims=" + w + "x" + h + " bytes=" + bytes);
    assert.equal(w, 736, "width 736");
    assert.equal(h, 1312, "height 1312");
  });

  it("no size/ratio still returns 1024x1024 (default regression guard)", async () => {
    const t = await loadTool();
    const r = await t.execute("c3", {
      prompt: "small default test, anime girl",
      response_format: "b64_json",
    });
    const { w, h, bytes } = readPngDims(r.details.filePath);
    console.log("  default dims=" + w + "x" + h + " bytes=" + bytes);
    assert.equal(w, 1024, "width 1024");
    assert.equal(h, 1024, "height 1024");
  });
});
