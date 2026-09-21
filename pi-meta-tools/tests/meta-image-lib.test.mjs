import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  buildImagePayload,
  errorHint,
  formatSavedImages,
  parseImageResponse,
  prepareImageUri,
  resolveApiKey,
  resolveBaseUrl,
  saveImageItem,
} from "../extensions/meta-image-lib.ts";

describe("buildImagePayload", () => {
  it("applies defaults for a minimal prompt", () => {
    assert.deepEqual(buildImagePayload({ prompt: "a cat" }), {
      model: DEFAULT_MODEL,
      prompt: "a cat",
      n: 1,
      output_format: "png",
      response_format: "b64_json",
      reasoning_strength: "high",
    });
  });

  it("passes through full options and reference images", () => {
    const payload = buildImagePayload({
      prompt: "edit this",
      model: "muse-image-1.0",
      n: 2,
      size: "1024x1536",
      output_format: "webp",
      reasoning_strength: "low",
      enable_web_search: false,
      images: ["data:image/png;base64,AAA", "https://example.com/a.png"],
    });
    assert.deepEqual(payload, {
      model: "muse-image-1.0",
      prompt: "edit this",
      n: 2,
      size: "1024x1536",
      output_format: "webp",
      response_format: "b64_json",
      reasoning_strength: "low",
      tool_enablement: { enable_image_search: true, enable_web_search: false, enable_shell: true },
      images: [{ image_url: "data:image/png;base64,AAA" }, { image_url: "https://example.com/a.png" }],
    });
  });

  it("rejects bad input", () => {
    assert.throws(() => buildImagePayload({ prompt: "  " }), /prompt is required/);
    assert.throws(() => buildImagePayload({ prompt: "x", n: 0 }), /n must be/);
    assert.throws(() => buildImagePayload({ prompt: "x", n: 11 }), /n must be/);
    assert.throws(() => buildImagePayload({ prompt: "x", n: 1.5 }), /n must be/);
    assert.throws(() => buildImagePayload({ prompt: "x", output_format: "gif" }), /output_format/);
    assert.throws(() => buildImagePayload({ prompt: "x", reasoning_strength: "max" }), /reasoning_strength/);
    assert.throws(() => buildImagePayload({ prompt: "x", size: "big" }), /Invalid size/);
  });
});

describe("prepareImageUri", () => {
  it("passes through URLs and data URIs", () => {
    assert.equal(prepareImageUri("https://example.com/a.png"), "https://example.com/a.png");
    assert.equal(prepareImageUri("data:image/png;base64,AAA"), "data:image/png;base64,AAA");
  });

  it("reads local files into data URIs", () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-tools-"));
    try {
      const p = join(dir, "a.jpg");
      writeFileSync(p, Buffer.from([1, 2, 3]));
      assert.equal(prepareImageUri(p), "data:image/jpeg;base64,AQID");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects empty and missing references", () => {
    assert.throws(() => prepareImageUri(""), /Empty image reference/);
    assert.throws(() => prepareImageUri("/no/such/file.png"), /does not exist/);
  });
});

describe("parseImageResponse", () => {
  it("accepts b64 and url items", () => {
    assert.deepEqual(parseImageResponse({ data: [{ b64_json: "AAA" }, { url: "https://x/y.png" }] }), [
      { b64: "AAA", url: null, mimeType: null },
      { b64: null, url: "https://x/y.png", mimeType: null },
    ]);
  });

  it("rejects empty or content-less bodies", () => {
    assert.throws(() => parseImageResponse({ data: [] }), /no image data/);
    assert.throws(() => parseImageResponse({}), /no image data/);
    assert.throws(() => parseImageResponse({ data: [{}] }), /neither b64_json nor url/);
  });
});

describe("resolveApiKey", () => {
  it("prefers env vars in order", () => {
    const runPiAuth = () => { throw new Error("should not run"); };
    assert.equal(resolveApiKey({ env: { MODEL_API_KEY: "m1" }, runPiAuth }), "m1");
    assert.equal(resolveApiKey({ env: { META_API_KEY: "m2" }, runPiAuth }), "m2");
    assert.equal(resolveApiKey({ env: { MODEL_API_KEY: "  ", MUSE_API_KEY: "m3" }, runPiAuth }), "m3");
  });

  it("falls back to pi auth then auth.json", () => {
    assert.equal(resolveApiKey({ env: {}, runPiAuth: () => "pi-token\n" }), "pi-token");
    const failing = () => { throw new Error("no pi"); };
    assert.equal(
      resolveApiKey({ env: {}, runPiAuth: failing, readAuthFile: () => JSON.stringify({ meta: { access: "file-token" } }) }),
      "file-token",
    );
  });

  it("throws with guidance when nothing is available", () => {
    const failing = () => { throw new Error("no pi"); };
    assert.throws(
      () => resolveApiKey({ env: {}, runPiAuth: failing, readAuthFile: () => { throw new Error("no file"); } }),
      /\/login/,
    );
  });
});

describe("resolveBaseUrl", () => {
  it("defaults and honors overrides", () => {
    assert.equal(resolveBaseUrl({}), DEFAULT_BASE_URL);
    assert.equal(resolveBaseUrl({ META_MODEL_API_BASE_URL: "https://x.test/v1///" }), "https://x.test/v1");
  });
});

describe("saveImageItem + formatSavedImages", () => {
  const startDir = process.cwd();
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meta-tools-"));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(startDir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes b64 payloads under .pi/generated-images", async () => {
    const saved = await saveImageItem(
      { b64: Buffer.from("img-bytes").toString("base64"), url: null, mimeType: "image/png" },
      { model: DEFAULT_MODEL, index: 1, outputFormat: "png" },
    );
    assert.ok(saved.filePath.endsWith(".png"));
    assert.deepEqual(readdirSync(join(dir, ".pi", "generated-images")).length, 1);
    const text = formatSavedImages([saved]);
    assert.match(text, /saved to:/);
  });

  it("downloads remote URLs when no b64 is present", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from("dl-bytes") });
    try {
      const saved = await saveImageItem(
        { b64: null, url: "https://example.com/i.png", mimeType: "image/png" },
        { model: DEFAULT_MODEL, index: 2, outputFormat: "png" },
      );
      assert.equal(saved.remoteUrl, "https://example.com/i.png");
      const text = formatSavedImages([saved]);
      assert.match(text, /example\.com/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("errorHint", () => {
  it("adds login guidance for auth failures only", () => {
    assert.match(errorHint(401), /\/login/);
    assert.match(errorHint(403), /MODEL_API_KEY/);
    assert.equal(errorHint(500), "");
  });

  it("explains the subscription-account block with a PAYG fix", () => {
    const msg = "This API surface is not available for subscription accounts. Switch to PAYG mode.";
    assert.match(errorHint(400, msg), /pay-as-you-go/);
    assert.match(errorHint(400, msg), /MODEL_API_KEY/);
  });
});
