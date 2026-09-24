import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import globalContextLimitExtension, {
  DEFAULT_ABSOLUTE_TOKEN_LIMIT,
  DEFAULT_CONTEXT_PERCENT,
  compactionThresholdTokens,
  decideCompaction,
  getSettingsPath,
  readSoftCompactionSettings,
  type SoftCompactionSettings,
} from "../extensions/global-context-limit.ts";

function settings(overrides: Partial<SoftCompactionSettings> = {}): SoftCompactionSettings {
  return {
    absoluteTokenLimit: 200_000,
    contextPercent: 80,
    cooldownMs: 30_000,
    hysteresisTokens: 8_000,
    ...overrides,
  };
}

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "soft-context-boundary-test-"));
}

test("defaults to 200k or 80% of native context, whichever comes first", () => {
  assert.equal(DEFAULT_ABSOLUTE_TOKEN_LIMIT, 200_000);
  assert.equal(DEFAULT_CONTEXT_PERCENT, 80);
  assert.equal(compactionThresholdTokens(1_000_000, settings()), 200_000);
  assert.equal(compactionThresholdTokens(200_000, settings()), 160_000);
  assert.equal(compactionThresholdTokens(128_000, settings()), 102_400);
  assert.equal(compactionThresholdTokens(0, settings()), 200_000);
});

test("the percentage boundary is configurable and clamped to a safe range", () => {
  const agentDir = tempAgentDir();
  try {
    const path = getSettingsPath(agentDir);
    writeFileSync(path, JSON.stringify({
      globalContextLimit: 300_000,
      globalContextCompactionPercent: 65,
      globalContextCompactionCooldownMs: 0,
      globalContextCompactionHysteresisTokens: 0,
    }));
    const loaded = readSoftCompactionSettings(path);
    assert.deepEqual(loaded, settings({
      absoluteTokenLimit: 300_000,
      contextPercent: 65,
      cooldownMs: 0,
      hysteresisTokens: 0,
    }));
    assert.equal(compactionThresholdTokens(1_000_000, loaded), 300_000);
    assert.equal(compactionThresholdTokens(200_000, loaded), 130_000);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the decision waits for an idle task boundary and hysteresis", () => {
  const usage = { tokens: 208_000, contextWindow: 1_000_000, percent: 20.8 };
  assert.equal(decideCompaction({ enabled: true, usage, settings: settings(), idle: false, compacting: false, lastCompactionAt: 0, now: 100_000 }).reason, "busy");
  assert.equal(decideCompaction({ enabled: true, usage, settings: settings(), idle: true, compacting: true, lastCompactionAt: 0, now: 100_000 }).reason, "compacting");
  assert.equal(decideCompaction({ enabled: true, usage, settings: settings(), idle: true, compacting: false, lastCompactionAt: 0, now: 100_000, requestPending: true }).reason, "pending");
  assert.equal(decideCompaction({ enabled: true, usage, settings: settings(), idle: true, compacting: false, lastCompactionAt: 99_000, now: 100_000 }).reason, "cooldown");
  assert.equal(decideCompaction({ enabled: true, usage: { tokens: 200_500, contextWindow: 1_000_000, percent: 20.05 }, settings: settings(), idle: true, compacting: false, lastCompactionAt: 0, now: 100_000 }).reason, "hysteresis");
  assert.equal(decideCompaction({ enabled: true, usage: { tokens: 100_000, contextWindow: 1_000_000, percent: 10 }, settings: settings(), idle: true, compacting: false, lastCompactionAt: 0, now: 100_000 }).reason, "below-threshold");

  const ready = decideCompaction({ enabled: true, usage, settings: settings(), idle: true, compacting: false, lastCompactionAt: 0, now: 100_000 });
  assert.equal(ready.shouldCompact, true);
  assert.equal(ready.reason, "absolute-cap");
});

test("percentage-threshold decisions are distinguishable from the absolute cap", () => {
  const decision = decideCompaction({
    enabled: true,
    usage: { tokens: 110_000, contextWindow: 128_000, percent: 85.9 },
    settings: settings({ cooldownMs: 0, hysteresisTokens: 0 }),
    idle: true,
    compacting: false,
    lastCompactionAt: 0,
    now: 100_000,
  });
  assert.equal(decision.shouldCompact, true);
  assert.equal(decision.reason, "threshold");
  assert.equal(decision.thresholdTokens, 102_400);
});

test("the extension requests Pi compaction once and resets on session_compact", async () => {
  const agentDir = tempAgentDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFileSync(getSettingsPath(agentDir), JSON.stringify({
      globalContextLimit: 200_000,
      globalContextCompactionPercent: 80,
      globalContextCompactionCooldownMs: 0,
      globalContextCompactionHysteresisTokens: 0,
    }));
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const commands = new Map<string, any>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
    } as any;
    globalContextLimitExtension(pi);

    const notices: string[] = [];
    let compactions = 0;
    const ctx = {
      model: Object.freeze({ provider: "openrouter", id: "stealth/space-bunny-alpha", contextWindow: 1_000_000, maxTokens: 128_000 }),
      getContextUsage: () => ({ tokens: 208_000, contextWindow: 1_000_000, percent: 20.8 }),
      isIdle: () => true,
      isCompacting: false,
      compact: () => { compactions++; },
      ui: { notify: (message: string) => notices.push(message) },
    };

    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.equal(compactions, 1, "pending state makes the coordinator idempotent");
    assert.ok(notices.some((message) => message.includes("Model limits are unchanged")));

    await handlers.get("session_compact")?.({}, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.equal(compactions, 2, "a successful Pi compaction rearms the boundary");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the coordinator latch stays closed while Pi owns a compaction retry", async () => {
  const agentDir = tempAgentDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFileSync(getSettingsPath(agentDir), JSON.stringify({
      globalContextLimit: 200_000,
      globalContextCompactionPercent: 80,
      globalContextCompactionCooldownMs: 0,
      globalContextCompactionHysteresisTokens: 0,
    }));
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); },
      registerCommand() {},
    } as any;
    globalContextLimitExtension(pi);

    let compactions = 0;
    const ctx = {
      model: Object.freeze({ provider: "openrouter", id: "stealth/space-bunny-alpha", contextWindow: 1_000_000, maxTokens: 128_000 }),
      getContextUsage: () => ({ tokens: 208_000, contextWindow: 1_000_000, percent: 20.8 }),
      isIdle: () => true,
      isCompacting: false,
      compact: () => { compactions++; },
      ui: { notify() {} },
    };

    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.equal(compactions, 1);

    await handlers.get("session_compact_failed")?.({ aborted: false, willRetry: true }, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.equal(compactions, 1, "a host-owned retry cannot enqueue a duplicate request");

    await handlers.get("session_compact_failed")?.({ aborted: false, willRetry: false }, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.equal(compactions, 2, "a terminal failure releases the latch for a later boundary");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the extension never writes models.json, models-store.json, or auth.json", async () => {
  const agentDir = tempAgentDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const settingsPath = getSettingsPath(agentDir);
    const modelsPath = join(agentDir, "models.json");
    const modelsStorePath = join(agentDir, "models-store.json");
    const authPath = join(agentDir, "auth.json");
    writeFileSync(settingsPath, JSON.stringify({ globalContextLimit: 200_000, theme: "dark" }));
    writeFileSync(modelsPath, JSON.stringify({ providers: { native: { modelOverrides: { model: { contextWindow: 1_000_000, maxTokens: 128_000 } } } } }));
    writeFileSync(modelsStorePath, JSON.stringify({ providers: { store: { models: [{ id: "model", contextWindow: 1_000_000, maxTokens: 128_000 }] } } }));
    writeFileSync(authPath, JSON.stringify({ provider: { type: "api_key", key: "test-only" } }));
    const before = [settingsPath, modelsPath, modelsStorePath, authPath].map((path) => readFileSync(path, "utf8"));

    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); },
      registerCommand() {},
    } as any;
    globalContextLimitExtension(pi);
    const ctx = {
      model: Object.freeze({ provider: "native", id: "model", contextWindow: 1_000_000, maxTokens: 128_000 }),
      getContextUsage: () => ({ tokens: 250_000, contextWindow: 1_000_000, percent: 25 }),
      isIdle: () => true,
      isCompacting: false,
      compact() {},
      ui: { notify() {} },
    };
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    await handlers.get("session_compact")?.({}, ctx);

    assert.deepEqual([settingsPath, modelsPath, modelsStorePath, authPath].map((path) => readFileSync(path, "utf8")), before);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
