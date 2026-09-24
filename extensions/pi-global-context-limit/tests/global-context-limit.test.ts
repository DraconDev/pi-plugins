import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import globalContextLimitExtension, {
  MIN_EFFECTIVE_OUTPUT_TOKENS,
  buildDesiredOverrides,
  capProviderPayload,
  clearManagedModelOverrides,
  getContextLimitPaths,
  modelOverrideFor,
  rebuildModelOverrides,
  type ModelLike,
} from "../extensions/global-context-limit.ts";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "global-context-limit-test-"));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function model(provider: string, id: string, contextWindow: number, maxTokens: number): ModelLike {
  return { provider, id, contextWindow, maxTokens };
}

test("model overrides cap every visible registry source without mutating frozen entries", () => {
  const models = [
    Object.freeze(model("native", "large", 1_000_000, 128_000)),
    Object.freeze(model("user-store", "large", 400_000, 64_000)),
    Object.freeze(model("extension", "large", 262_144, 32_768)),
    Object.freeze(model("native", "small", 128_000, 8_192)),
  ];

  const desired = buildDesiredOverrides(models, 200_000);

  assert.deepEqual(desired.native.large, { contextWindow: 200_000, maxTokens: 32_768 });
  assert.deepEqual(desired["user-store"].large, { contextWindow: 200_000, maxTokens: 32_768 });
  assert.deepEqual(desired.extension.large, { contextWindow: 200_000 });
  assert.equal(desired.native.small, undefined);
  assert.equal(models[0]?.contextWindow, 1_000_000, "frozen native source is unchanged");
  assert.equal(models[1]?.contextWindow, 400_000, "frozen user-store source is unchanged");
});

test("rebuild composes native, user-store, and extension-registered paths while preserving user config", () => {
  const agentDir = tempAgentDir();
  try {
    const paths = getContextLimitPaths(agentDir);
    writeFileSync(paths.settingsPath, JSON.stringify({ globalContextLimit: 200_000 }));
    writeFileSync(paths.modelsStorePath, JSON.stringify({
      providers: {
        "user-store": { models: [model("user-store", "large", 400_000, 64_000)] },
      },
    }));
    writeFileSync(paths.modelsPath, JSON.stringify({
      providers: {
        native: {
          api: "openai-completions",
          baseUrl: "https://example.invalid",
          modelOverrides: {
            large: {
              contextWindow: 175_000,
              maxTokens: 24_000,
              name: "User large",
              headers: { "x-user": "kept" },
            },
          },
        },
      },
    }));
    const storeBefore = readFileSync(paths.modelsStorePath, "utf8");
    const registryModels = [
      model("native", "large", 1_000_000, 128_000),
      model("user-store", "large", 400_000, 64_000),
      model("extension-registered", "frozen", 1_048_576, 524_288),
    ];

    const first = rebuildModelOverrides(200_000, registryModels, paths);
    assert.equal(first.error, undefined);
    assert.equal(first.scanned, 3);
    assert.equal(first.written, 3);

    const composed = readJson(paths.modelsPath);
    assert.deepEqual(composed.providers.native.modelOverrides.large, {
      contextWindow: 200_000,
      maxTokens: 32_768,
      name: "User large",
      headers: { "x-user": "kept" },
    });
    assert.deepEqual(composed.providers["user-store"].modelOverrides.large, {
      contextWindow: 200_000,
      maxTokens: 32_768,
    });
    assert.deepEqual(composed.providers["extension-registered"].modelOverrides.frozen, {
      contextWindow: 200_000,
      maxTokens: 32_768,
    });
    assert.equal(readFileSync(paths.modelsStorePath, "utf8"), storeBefore, "the user model store is read-only");
    assert.equal("models" in composed.providers["extension-registered"], false, "no model is fabricated");

    const second = rebuildModelOverrides(200_000, registryModels, paths);
    assert.equal(second.changed, false, "rebuild is idempotent");
    assert.equal(second.written, 0);

    const cleared = clearManagedModelOverrides(paths);
    assert.equal(cleared.error, undefined);
    const restored = readJson(paths.modelsPath);
    assert.deepEqual(restored.providers.native.modelOverrides.large, {
      contextWindow: 175_000,
      maxTokens: 24_000,
      name: "User large",
      headers: { "x-user": "kept" },
    });
    assert.equal(restored.providers["user-store"], undefined);
    assert.equal(restored.providers["extension-registered"], undefined);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("near-cap provider requests receive a usable 1,024-token floor", () => {
  const spaceBunny = {
    api: "openai-completions",
    contextWindow: 200_000,
    maxTokens: 32_768,
  };
  const nearCap = {
    model: "stealth/space-bunny-alpha",
    messages: [{ role: "user", content: "x".repeat(778_000) }],
    max_completion_tokens: 1,
  };

  const capped = capProviderPayload(nearCap, spaceBunny, 200_000) as Record<string, unknown>;
  assert.equal(capped.max_completion_tokens, MIN_EFFECTIVE_OUTPUT_TOKENS);
  assert.equal(MIN_EFFECTIVE_OUTPUT_TOKENS, 1_024);
});

test("an actually over-cap payload is left for Pi overflow recovery, not given a fabricated budget", () => {
  const payload = {
    model: "stealth/space-bunny-alpha",
    messages: [{ role: "user", content: "x".repeat(900_000) }],
    max_completion_tokens: 1,
  };
  const model = { api: "openai-completions", contextWindow: 200_000, maxTokens: 32_768 };

  assert.equal(capProviderPayload(payload, model, 200_000), payload);
});

test("OpenAI completion payload uses the compatibility-selected field and preserves smaller budgets", () => {
  const model = {
    api: "openai-completions",
    compat: { maxTokensField: "max_tokens" },
    contextWindow: 200_000,
    maxTokens: 32_768,
  };
  const payload = { messages: [{ role: "user", content: "hello" }], max_tokens: 512 };

  assert.equal(capProviderPayload(payload, model, 200_000), payload);
  assert.equal((capProviderPayload({ ...payload, max_tokens: 32_768 }, model, 200_000) as Record<string, unknown>).max_tokens, 1_024);
});

test("session_start refreshes a frozen current model and selects the capped replacement", async () => {
  const agentDir = tempAgentDir();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const paths = getContextLimitPaths(agentDir);
    writeFileSync(paths.settingsPath, JSON.stringify({ globalContextLimit: 200_000 }));
    const current = Object.freeze(model("extension-registered", "frozen", 1_048_576, 524_288));
    const replacement = model("extension-registered", "frozen", 200_000, 32_768);
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const selected: unknown[] = [];
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); },
      registerCommand() {},
      async setModel(value: unknown) { selected.push(value); return true; },
    } as any;
    globalContextLimitExtension(pi);
    const ctx = {
      model: current,
      modelRegistry: {
        getAll: () => [current],
        find: () => replacement,
        refresh: async () => ({}),
      },
      ui: { notify() {} },
    };

    await handlers.get("session_start")?.({ reason: "startup" }, ctx);

    assert.deepEqual(selected, [replacement]);
    assert.equal(current.contextWindow, 1_048_576, "frozen current model was not mutated");
    assert.equal(readJson(paths.modelsPath).providers["extension-registered"].modelOverrides.frozen.contextWindow, 200_000);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Pi ModelRuntime composes native, user-store, and extension-registered models through managed overrides", async () => {
  const agentDir = tempAgentDir();
  try {
    const paths = getContextLimitPaths(agentDir);
    writeFileSync(paths.settingsPath, JSON.stringify({ globalContextLimit: 200_000 }));
    writeFileSync(paths.modelsStorePath, JSON.stringify({
      providers: {
        "user-store": {
          models: [{
            id: "large",
            name: "User-store large",
            api: "openai-completions",
            baseUrl: "https://example.invalid",
            contextWindow: 400_000,
            maxTokens: 64_000,
          }],
        },
      },
    }));
    let runtime = await ModelRuntime.create({
      agentDir,
      modelsPath: paths.modelsPath,
      modelsStorePath: paths.modelsStorePath,
      refreshOnCreate: false,
    });
    runtime.registerProvider("extension-registered", {
      api: "openai-completions",
      baseUrl: "https://extension.invalid",
      models: [{ id: "frozen", name: "Extension large", api: "openai-completions", baseUrl: "https://extension.invalid", contextWindow: 1_048_576, maxTokens: 524_288 }],
      apiKey: "test-only",
    });
    runtime.registerProvider("native-test", {
      api: "openai-completions",
      baseUrl: "https://native.invalid",
      models: [{ id: "large", name: "Native large", api: "openai-completions", baseUrl: "https://native.invalid", contextWindow: 1_000_000, maxTokens: 128_000 }],
      apiKey: "test-only",
    });
    await runtime.refresh({ allowNetwork: false });
    const before = [
      runtime.getModel("native-test", "large"),
      runtime.getModel("user-store", "large"),
      runtime.getModel("extension-registered", "frozen"),
    ];
    assert.ok(before.every(Boolean));

    const result = rebuildModelOverrides(200_000, before as ModelLike[], paths);
    assert.equal(result.error, undefined);
    await runtime.refresh({ allowNetwork: false });
    runtime = await ModelRuntime.create({
      agentDir,
      modelsPath: paths.modelsPath,
      modelsStorePath: paths.modelsStorePath,
      refreshOnCreate: false,
    });
    runtime.registerProvider("extension-registered", {
      api: "openai-completions",
      baseUrl: "https://extension.invalid",
      models: [{ id: "frozen", name: "Extension large", api: "openai-completions", baseUrl: "https://extension.invalid", contextWindow: 1_048_576, maxTokens: 524_288 }],
      apiKey: "test-only",
    });
    runtime.registerProvider("native-test", {
      api: "openai-completions",
      baseUrl: "https://native.invalid",
      models: [{ id: "large", name: "Native large", api: "openai-completions", baseUrl: "https://native.invalid", contextWindow: 1_000_000, maxTokens: 128_000 }],
      apiKey: "test-only",
    });
    await runtime.refresh({ allowNetwork: false });

    assert.deepEqual(
      [runtime.getModel("native-test", "large"), runtime.getModel("user-store", "large"), runtime.getModel("extension-registered", "frozen")]
        .map((entry) => entry && ({ provider: entry.provider, id: entry.id, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens })),
      [
        { provider: "native-test", id: "large", contextWindow: 200_000, maxTokens: 32_768 },
        { provider: "user-store", id: "large", contextWindow: 200_000, maxTokens: 32_768 },
        { provider: "extension-registered", id: "frozen", contextWindow: 200_000, maxTokens: 32_768 },
      ],
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("modelOverrideFor leaves a model with unknown context metadata untouched", () => {
  assert.equal(modelOverrideFor({ provider: "x", id: "unknown", maxTokens: 999_999 }, 200_000), undefined);
});
