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
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

register("./hooks.mjs", import.meta.url);

// This file makes live Agnes API calls (~40s, 3 generations). It runs only
// when a key is available — env AGNES_API_KEY or the /login-stored key in
// ~/.pi/agent/auth.json. Without either, every test in this file is
// .skip()ped so the published package installs cleanly under `node --test`
// in CI / fresh environments.
function resolveKey() {
  if (process.env.AGNES_API_KEY) return process.env.AGNES_API_KEY;
  try {
    const p = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(readFileSync(p, "utf8"));
    return (auth.agnes && auth.agnes.key) || (auth["agnes-cn"] && auth["agnes-cn"].key) || null;
  } catch {
    return null;
  }
}
const agnesKey = resolveKey();
const gate = (name, fn) =>
  agnesKey
    ? it(name, fn)
    : it(
        name,
        { skip: "no AGNES_API_KEY / auth.json key — runtime test skipped" },
        fn
      );

async function loadTool() {
  const tools = [];
  const ext = (await import("../extensions/agnes-tools.ts")).default;
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
  gate("2K + 16:9 returns 2624x1472", async () => {
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

  gate("1K + 9:16 returns 736x1312", async () => {
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

  gate("no size/ratio still returns 1024x1024 (default regression guard)", async () => {
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
