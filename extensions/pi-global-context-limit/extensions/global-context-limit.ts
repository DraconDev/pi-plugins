/**
 * Durable global context cap for Pi.
 *
 * Pi composes models.json modelOverrides after built-in, models-store, user
 * models, extension registrations, and extension refreshes. We use that
 * public composition layer to cap every model visible in ExtensionContext's
 * ModelRegistry, then refresh Pi's public registry facade. Frozen catalog
 * entries are never mutated.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MIN_EFFECTIVE_OUTPUT_TOKENS = 256;
const TARGET_OUTPUT_TOKENS = 1_024;
const PAYLOAD_CONTEXT_RESERVE_TOKENS = 4_096;
const STATE_VERSION = 1;

const CONTEXT_OUTPUT_CAPS: ReadonlyArray<{ context: number; output: number }> = [
  { context: 32_768, output: 4_096 },
  { context: 131_072, output: 8_192 },
  { context: 262_144, output: 32_768 },
  { context: 524_288, output: 65_536 },
];

export interface ContextLimitPaths {
  agentDir: string;
  modelsPath: string;
  modelsStorePath: string;
  settingsPath: string;
  statePath: string;
}

export interface ModelLike {
  id: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelOverride {
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

interface ProviderConfigShape {
  models?: Array<Record<string, unknown> & { id: string }>;
  modelOverrides?: Record<string, ModelOverride>;
  [key: string]: unknown;
}

interface ModelsJsonShape {
  providers: Record<string, ProviderConfigShape>;
}

interface ManagedField {
  hadPrevious: boolean;
  previous?: number;
  applied: number;
}

interface ManagedEntry {
  contextWindow?: ManagedField;
  maxTokens?: ManagedField;
}

interface ManageStateShape {
  version: number;
  entries: Record<string, ManagedEntry>;
}

export interface RebuildResult {
  scanned: number;
  written: number;
  skipped: number;
  changed: boolean;
  error?: string;
}

type JsonRecord = Record<string, unknown>;

const PINNED_SPACE_BUNNY_MODEL = {
  id: "space-bunny-free",
  name: "Space Bunny Free",
  api: "openai-completions",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 524_288,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
} as const;

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getContextLimitPaths(agentDir = getAgentDir()): ContextLimitPaths {
  return {
    agentDir,
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    settingsPath: join(agentDir, "settings.json"),
    statePath: join(agentDir, "global-context-limit-state.json"),
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function readGlobalContextLimit(paths = getContextLimitPaths()): number | undefined {
  if (!existsSync(paths.settingsPath)) return undefined;
  try {
    const settings: unknown = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
    return isRecord(settings) ? positiveInteger(settings.globalContextLimit) : undefined;
  } catch {
    return undefined;
  }
}

export function contextOutputCap(contextWindow: number): number {
  return CONTEXT_OUTPUT_CAPS.find(({ context }) => contextWindow <= context)?.output ?? 65_536;
}

function safeModelOutputCap(contextWindow: number, declaredMaxTokens?: number): number {
  const contextCap = contextOutputCap(contextWindow);
  if (declaredMaxTokens === undefined) return contextCap;
  return Math.max(1, Math.min(declaredMaxTokens, contextCap));
}

export function modelOverrideFor(model: ModelLike, limit: number): ModelOverride | undefined {
  const contextWindow = positiveInteger(model.contextWindow);
  const maxTokens = positiveInteger(model.maxTokens);
  const override: ModelOverride = {};

  if (contextWindow !== undefined && contextWindow > limit) override.contextWindow = limit;
  if (maxTokens !== undefined) {
    const outputCap = safeModelOutputCap(contextWindow === undefined ? limit : Math.min(contextWindow, limit), maxTokens);
    if (maxTokens > outputCap) override.maxTokens = outputCap;
  }

  return Object.keys(override).length > 0 ? override : undefined;
}

export function buildDesiredOverrides(
  models: readonly ModelLike[],
  limit: number,
): Record<string, Record<string, ModelOverride>> {
  const desired: Record<string, Record<string, ModelOverride>> = {};
  for (const model of models) {
    if (typeof model.provider !== "string" || typeof model.id !== "string") continue;
    const override = modelOverrideFor(model, limit);
    if (!override) continue;
    desired[model.provider] ??= {};
    desired[model.provider][model.id] = override;
  }
  return desired;
}

function readModelsJson(paths: ContextLimitPaths): { value: ModelsJsonShape; raw?: string } {
  if (!existsSync(paths.modelsPath)) return { value: { providers: {} } };
  const raw = readFileSync(paths.modelsPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new Error("models.json must contain a providers object");
  }
  for (const provider of Object.values(parsed.providers)) {
    if (!isRecord(provider)) throw new Error("models.json contains an invalid provider entry");
    if (provider.models !== undefined && !Array.isArray(provider.models)) {
      throw new Error("models.json contains an invalid models list");
    }
    if (provider.modelOverrides !== undefined && !isRecord(provider.modelOverrides)) {
      throw new Error("models.json contains invalid modelOverrides");
    }
  }
  return { value: parsed as unknown as ModelsJsonShape, raw };
}

function readState(paths: ContextLimitPaths): ManageStateShape {
  if (!existsSync(paths.statePath)) return { version: STATE_VERSION, entries: {} };
  const parsed: unknown = JSON.parse(readFileSync(paths.statePath, "utf8"));
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !isRecord(parsed.entries)) {
    throw new Error("global-context-limit-state.json is invalid");
  }
  return parsed as unknown as ManageStateShape;
}

function modelKey(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function providerEntry(models: ModelsJsonShape, provider: string): ProviderConfigShape | undefined {
  return models.providers[provider];
}

function removeEmptyOverrides(models: ModelsJsonShape, provider: string): void {
  const config = providerEntry(models, provider);
  if (!config) return;
  if (config.modelOverrides && Object.keys(config.modelOverrides).length === 0) delete config.modelOverrides;
  if (Object.keys(config).length === 0) delete models.providers[provider];
}

function restoreManagedFields(
  models: ModelsJsonShape,
  state: ManageStateShape,
  onRestored?: (provider: string, model: string, field: "contextWindow" | "maxTokens", value: unknown) => void,
): void {
  for (const [key, entry] of Object.entries(state.entries)) {
    let parsedKey: [string, string];
    try {
      const value: unknown = JSON.parse(key);
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") {
        throw new Error();
      }
      parsedKey = [value[0], value[1]];
    } catch {
      continue;
    }
    const [provider, model] = parsedKey;
    const override = models.providers[provider]?.modelOverrides?.[model];
    if (!override) continue;

    for (const field of ["contextWindow", "maxTokens"] as const) {
      const managed = entry[field];
      if (!managed || override[field] !== managed.applied) continue;
      if (managed.hadPrevious) override[field] = managed.previous;
      else delete override[field];
      onRestored?.(provider, model, field, managed.hadPrevious ? managed.previous : undefined);
    }
    removeEmptyOverrides(models, provider);
  }
}

function ensurePinnedModels(models: ModelsJsonShape): ModelLike[] {
  const pinned: ModelLike[] = [];
  for (const provider of ["opencode", "opencode-go"]) {
    const config = (models.providers[provider] ??= {});
    const definitions = Array.isArray(config.models) ? config.models : (config.models = []);
    let definition = definitions.find((candidate) => isRecord(candidate) && candidate.id === PINNED_SPACE_BUNNY_MODEL.id);
    if (!definition) {
      definition = structuredClone(PINNED_SPACE_BUNNY_MODEL) as unknown as Record<string, unknown> & { id: string };
      definitions.push(definition);
    }
    pinned.push({
      id: PINNED_SPACE_BUNNY_MODEL.id,
      provider,
      contextWindow: positiveInteger(definition.contextWindow),
      maxTokens: positiveInteger(definition.maxTokens),
    });
  }
  return pinned;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode: number | undefined;
  try {
    mode = statSync(path).mode;
  } catch {
    // New files use the process umask and default permissions.
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename already removed it.
    }
  }
}

function removeFileIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function rebuildModelOverrides(
  limit: number,
  registryModels: readonly ModelLike[],
  paths = getContextLimitPaths(),
): RebuildResult {
  let models: ModelsJsonShape;
  let rawModels: string | undefined;
  let state: ManageStateShape;
  try {
    const loaded = readModelsJson(paths);
    models = loaded.value;
    rawModels = loaded.raw;
    state = readState(paths);
  } catch (error) {
    return { scanned: registryModels.length, written: 0, skipped: 0, changed: false, error: (error as Error).message };
  }

  restoreManagedFields(models, state);
  const visibleModels = [
    ...registryModels,
    ...ensurePinnedModels(models).filter(
      (pinned) => !registryModels.some((model) => model.provider === pinned.provider && model.id === pinned.id),
    ),
  ];
  const desired = buildDesiredOverrides(visibleModels, limit);
  const nextState: ManageStateShape = { version: STATE_VERSION, entries: {} };
  let written = 0;
  let skipped = 0;

  for (const [provider, modelOverrides] of Object.entries(desired)) {
    const providerConfig = (models.providers[provider] ??= {});
    const existing = providerConfig.modelOverrides ?? {};
    providerConfig.modelOverrides = existing;
    for (const [model, fields] of Object.entries(modelOverrides)) {
      const before = { ...(existing[model] ?? {}) };
      const merged = { ...(existing[model] ?? {}), ...fields };
      const entry: ManagedEntry = {};
      for (const field of ["contextWindow", "maxTokens"] as const) {
        const applied = fields[field];
        if (applied === undefined) continue;
        const hadPrevious = Object.prototype.hasOwnProperty.call(before, field);
        entry[field] = { hadPrevious, previous: hadPrevious ? before[field] as number : undefined, applied };
        merged[field] = applied;
      }
      existing[model] = merged;
      nextState.entries[modelKey(provider, model)] = entry;
      if (before.contextWindow === merged.contextWindow && before.maxTokens === merged.maxTokens) skipped++;
      else written++;
    }
  }

  const nextModelsText = serializeJson(models);
  const nextStateText = serializeJson(nextState);
  const rawState = existsSync(paths.statePath) ? readFileSync(paths.statePath, "utf8") : undefined;
  const changed = nextModelsText !== rawModels || nextStateText !== rawState;
  if (!changed) return { scanned: visibleModels.length, written: 0, skipped, changed: false };

  try {
    writeFileAtomic(paths.modelsPath, nextModelsText);
    writeFileAtomic(paths.statePath, nextStateText);
  } catch (error) {
    return { scanned: visibleModels.length, written, skipped, changed: false, error: (error as Error).message };
  }
  return { scanned: visibleModels.length, written, skipped, changed: true };
}

export function clearManagedModelOverrides(paths = getContextLimitPaths()): RebuildResult {
  let models: ModelsJsonShape;
  let rawModels: string | undefined;
  let state: ManageStateShape;
  try {
    const loaded = readModelsJson(paths);
    models = loaded.value;
    rawModels = loaded.raw;
    state = readState(paths);
  } catch (error) {
    return { scanned: 0, written: 0, skipped: 0, changed: false, error: (error as Error).message };
  }

  let restored = 0;
  restoreManagedFields(models, state, (_provider, _model, field, value) => {
    restored += value === undefined || field === "contextWindow" || field === "maxTokens" ? 1 : 0;
  });
  const nextModelsText = serializeJson(models);
  const changed = nextModelsText !== rawModels;
  if (!changed) {
    removeFileIfPresent(paths.statePath);
    return { scanned: Object.keys(state.entries).length, written: 0, skipped: restored, changed: false };
  }

  try {
    if (Object.keys(models.providers).length === 0) removeFileIfPresent(paths.modelsPath);
    else writeFileAtomic(paths.modelsPath, nextModelsText);
    removeFileIfPresent(paths.statePath);
  } catch (error) {
    return { scanned: Object.keys(state.entries).length, written: restored, skipped: 0, changed: false, error: (error as Error).message };
  }
  return { scanned: Object.keys(state.entries).length, written: restored, skipped: 0, changed: true };
}

function updateSettingsLimit(limit: number | undefined, paths: ContextLimitPaths): string | undefined {
  let settings: JsonRecord = {};
  if (existsSync(paths.settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
      if (!isRecord(parsed)) return "settings.json must contain a JSON object";
      settings = parsed;
    } catch (error) {
      return (error as Error).message;
    }
  }
  if (limit === undefined) delete settings.globalContextLimit;
  else settings.globalContextLimit = limit;
  try {
    writeFileAtomic(paths.settingsPath, serializeJson(settings));
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

function estimatePayloadTokens(payload: unknown): number {
  try {
    return Math.ceil((JSON.stringify(payload)?.length ?? 0) / 4);
  } catch {
    return 0;
  }
}

function isObjectPayload(payload: unknown): payload is JsonRecord {
  return isRecord(payload);
}

function readPath(payload: JsonRecord, path: readonly string[]): unknown {
  let value: unknown = payload;
  for (const segment of path) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function writePath(payload: JsonRecord, path: readonly string[], value: number): JsonRecord {
  if (path.length === 1) return { ...payload, [path[0]]: value };
  const [head, ...tail] = path;
  const child = isRecord(payload[head]) ? payload[head] : {};
  return { ...payload, [head]: writePath(child, tail, value) };
}

function outputPathsForModel(model: JsonRecord): string[][] {
  switch (model.api) {
    case "openai-completions":
      return [["max_tokens"], ["max_completion_tokens"]];
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return [["max_output_tokens"]];
    case "anthropic-messages":
      return [["max_tokens"]];
    case "bedrock-converse-stream":
      return [["inferenceConfig", "maxTokens"]];
    case "google-generative-ai":
    case "google-vertex":
      return [["generationConfig", "maxOutputTokens"]];
    case "mistral-conversations":
      return [["maxTokens"]];
    case "pi-messages":
      return [["options", "maxTokens"]];
    default:
      return [];
  }
}

/** Cap output fields in all built-in JSON provider payload shapes. */
export function capProviderPayload(payload: unknown, modelValue: unknown, limit: number): unknown {
  if (!isObjectPayload(payload) || !isRecord(modelValue)) return payload;
  const paths = outputPathsForModel(modelValue);
  if (paths.length === 0) return payload;

  const nativeContext = positiveInteger(modelValue.contextWindow);
  const effectiveContext = nativeContext === undefined ? limit : Math.min(nativeContext, limit);
  const declaredMax = positiveInteger(modelValue.maxTokens);
  const outputCap = safeModelOutputCap(effectiveContext, declaredMax);
  const available = effectiveContext - estimatePayloadTokens(payload) - PAYLOAD_CONTEXT_RESERVE_TOKENS;
  if (!Number.isFinite(available) || available < MIN_EFFECTIVE_OUTPUT_TOKENS) return payload;

  const budget = Math.max(
    MIN_EFFECTIVE_OUTPUT_TOKENS,
    Math.min(outputCap, TARGET_OUTPUT_TOKENS, Math.floor(available)),
  );
  let capped = payload;
  let changed = false;
  for (const path of paths) {
    const current = readPath(capped, path);
    if (typeof current !== "number" || !Number.isFinite(current) || current <= 0 || current > budget) {
      capped = writePath(capped, path, budget);
      changed = true;
    }
  }
  return changed ? capped : payload;
}

interface HostContext {
  model?: JsonRecord;
  modelRegistry: {
    getAll(): ModelLike[];
    refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
  };
  ui: { notify(message: string, level?: string): void };
}

interface HostPi extends ExtensionAPI {
  setModel(model: ModelLike): Promise<boolean>;
}

function sameModel(left: ModelLike | undefined, right: ModelLike | undefined): boolean {
  return left?.provider === right?.provider && left?.id === right?.id;
}

export default function globalContextLimitExtension(pi: ExtensionAPI): void {
  const paths = getContextLimitPaths();
  let activeLimit = readGlobalContextLimit(paths);
  let lastRebuild: RebuildResult | undefined;

  const ensureRegistryAndModel = async (ctx: HostContext, persist: boolean): Promise<void> => {
    activeLimit = readGlobalContextLimit(paths) ?? activeLimit;
    if (activeLimit === undefined) return;
    const current = ctx.model as ModelLike | undefined;

    if (persist) lastRebuild = rebuildModelOverrides(activeLimit, ctx.modelRegistry.getAll(), paths);
    if (lastRebuild?.error) {
      ctx.ui.notify(`Global context limit could not be applied: ${lastRebuild.error}`, "error");
      return;
    }

    const currentNeedsCap = current !== undefined && modelOverrideFor(current, activeLimit) !== undefined;
    if (!currentNeedsCap) return;
    try {
      await ctx.modelRegistry.refresh({ allowNetwork: false });
      const replacement = ctx.modelRegistry.find?.(current.provider, current.id) as ModelLike | undefined;
      if (replacement && !sameModel(current, replacement) === false) await pi.setModel(replacement);
      else if (replacement) await pi.setModel(replacement);
    } catch {
      // The request hook remains the final supported boundary for this turn.
    }
  };

  // Always installed: /context-limit can enable the cap after extension load.
  pi.on("before_provider_request", async (event, ctx) => {
    activeLimit = readGlobalContextLimit(paths) ?? activeLimit;
    if (activeLimit === undefined) return;
    return capProviderPayload(event.payload, ctx.model, activeLimit);
  });

  pi.on("session_start", async (_event, ctx) => {
    activeLimit = readGlobalContextLimit(paths);
    await ensureRegistryAndModel(ctx as unknown as HostContext, activeLimit !== undefined);
    if (activeLimit !== undefined) {
      const detail = lastRebuild?.error ? ` (${lastRebuild.error})` : "";
      ctx.ui.notify(
        `Global context limit: ${activeLimit.toLocaleString()} tokens${detail}. Pi's normal compactor remains active.`,
        lastRebuild?.error ? "error" : "info",
      );
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    await ensureRegistryAndModel(ctx as unknown as HostContext, true);
  });

  // These precede compaction/request preparation and recover from a dynamic
  // provider refresh that replaced the current frozen catalog object.
  pi.on("input", async () => undefined);
  pi.on("turn_start", async (_event, ctx) => {
    await ensureRegistryAndModel(ctx as unknown as HostContext, true);
  });

  pi.registerCommand("context-limit", {
    description: "Show, set, rebuild, or clear the global model context limit",
    handler: async (args, commandCtx) => {
      const ctx = commandCtx as unknown as HostContext;
      const value = args.trim();
      if (!value) {
        const current = readGlobalContextLimit(paths);
        commandCtx.ui.notify(current ? `Global context limit: ${current.toLocaleString()} tokens` : "No global context limit set", "info");
        return;
      }

      if (value === "rebuild" || value === "clear") {
        activeLimit = readGlobalContextLimit(paths);
        if (value === "clear") {
          const settingsError = updateSettingsLimit(undefined, paths);
          if (settingsError) {
            commandCtx.ui.notify(`Could not clear limit: ${settingsError}`, "error");
            return;
          }
          activeLimit = undefined;
        }
        if (activeLimit === undefined) {
          const result = clearManagedModelOverrides(paths);
          if (result.error) commandCtx.ui.notify(`Could not clear managed overrides: ${result.error}`, "error");
          else commandCtx.ui.notify("Global context limit cleared. User-authored model overrides were preserved.", "info");
        } else {
          lastRebuild = rebuildModelOverrides(activeLimit, ctx.modelRegistry.getAll(), paths);
          if (lastRebuild.error) commandCtx.ui.notify(`Rebuild failed: ${lastRebuild.error}`, "error");
          else commandCtx.ui.notify(`Global context limit: ${activeLimit.toLocaleString()}; ${lastRebuild.written} model override(s) updated.`, "info");
        }
        try {
          await ctx.modelRegistry.refresh({ allowNetwork: false });
        } catch (error) {
          commandCtx.ui.notify(`Pi model registry refresh failed: ${(error as Error).message}`, "error");
        }
        return;
      }

      if (!/^\d+$/.test(value)) {
        commandCtx.ui.notify("Invalid limit. Use a whole number of at least 1000.", "error");
        return;
      }
      const limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1_000) {
        commandCtx.ui.notify("Invalid limit. Use a whole number of at least 1000.", "error");
        return;
      }
      const settingsError = updateSettingsLimit(limit, paths);
      if (settingsError) {
        commandCtx.ui.notify(`Could not save limit: ${settingsError}`, "error");
        return;
      }
      activeLimit = limit;
      lastRebuild = rebuildModelOverrides(limit, ctx.modelRegistry.getAll(), paths);
      if (lastRebuild.error) {
        commandCtx.ui.notify(`Limit saved, but overrides failed: ${lastRebuild.error}`, "error");
        return;
      }
      await ensureRegistryAndModel(ctx, false);
      commandCtx.ui.notify(`Global context limit set to ${limit.toLocaleString()} tokens; ${lastRebuild.written} model override(s) updated.`, "info");
    },
  });
}
