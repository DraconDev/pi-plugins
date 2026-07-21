/**
 * Global Context Limit Extension for pi
 *
 * Adds a `globalContextLimit` setting that caps every model's effective
 * contextWindow, regardless of its native size. Affects footer display,
 * compaction triggers, and (via before_provider_request) API request output
 * budgets.
 *
 * Why this is needed:
 *   pi v0.80.8+ deep-freezes models.json / models-store.json entries, so an
 *   in-place mutation (model.contextWindow = limit) throws TypeError on those
 *   models. To work around that, on startup this extension writes
 *   `~/.pi/agent/models.json` with `modelOverrides` for every provider/model
 *   whose native contextWindow exceeds the limit. Pi's ModelConfig respects
 *   those overrides and emits an unfrozen spread object, so the cap sticks
 *   even on otherwise-frozen providers.
 *
 *   For extension-registered providers (e.g. `pi-minimax-m3-caching-fix`)
 *   that bypass models.json entirely, the in-place mutation path still runs
 *   (and now has a try/catch so it won't crash on frozen objects).
 *
 * Usage: Add `"globalContextLimit": 200000` to ~/.pi/agent/settings.json.
 *        Then `/reload` to pick up the generated overrides.
 *
 * Run `/context-limit` to view or change the active limit at runtime. Run
 * `/context-limit rebuild` to re-scan models-store.json and refresh the
 * generated overrides without restarting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const MIN_COMPLETION_TOKENS = 1_024;
const PAYLOAD_TOKEN_ESTIMATE_PADDING = 4_096;

const CONTEXT_SAFE_MAX_TOKENS: Array<{ maxContext: number; maxTokens: number }> = [
  { maxContext: 32_768, maxTokens: 4_096 },
  { maxContext: 131_072, maxTokens: 8_192 },
  { maxContext: 262_144, maxTokens: 32_768 },
  { maxContext: 524_288, maxTokens: 65_536 },
];

function getAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env;
  const os = require("node:os");
  return join(os.homedir(), ".pi", "agent");
}

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function getModelsStorePath(): string {
  return join(getAgentDir(), "models-store.json");
}

function getSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readGlobalContextLimit(): number | null {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) return null;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const value = settings.globalContextLimit;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    return null;
  } catch {
    return null;
  }
}

function toPositiveInteger(value: unknown, fallback: number): number {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numberValue) || numberValue <= 0) return fallback;
  return Math.floor(numberValue);
}

function getSafeMaxTokens(contextWindow: number, modelMaxTokens?: number): number {
  const contextCap = CONTEXT_SAFE_MAX_TOKENS.find(({ maxContext }) => contextWindow <= maxContext)?.maxTokens ?? 65_536;
  const modelCap = modelMaxTokens && modelMaxTokens > 0 ? modelMaxTokens : contextCap;
  return Math.max(MIN_COMPLETION_TOKENS, Math.min(modelCap, contextCap));
}

function estimatePayloadTokens(payload: unknown): number {
  try {
    return Math.max(0, Math.ceil((JSON.stringify(payload)?.length ?? 0) / 4));
  } catch {
    return 0;
  }
}

function capPayloadMaxTokens(payload: unknown, model: any): unknown {
  if (!payload || typeof payload !== "object" || !model || model.api !== "openai-completions") return payload;

  const contextWindow = toPositiveInteger(model.contextWindow, 0);
  const declaredMaxTokens = toPositiveInteger(model.maxTokens, 0);
  const maxTokensField = model.compat?.maxTokensField === "max_tokens" ? "max_tokens" : "max_completion_tokens";
  const payloadMaxTokens = Number((payload as Record<string, unknown>)[maxTokensField]);
  let safeMaxTokens = getSafeMaxTokens(contextWindow, declaredMaxTokens);

  if (contextWindow > 0) {
    const availableForCompletion = contextWindow - estimatePayloadTokens(payload) - PAYLOAD_TOKEN_ESTIMATE_PADDING;
    if (availableForCompletion > 0) {
      safeMaxTokens = Math.min(safeMaxTokens, Math.floor(availableForCompletion));
    }
  }

  safeMaxTokens = Math.max(MIN_COMPLETION_TOKENS, Math.floor(safeMaxTokens));
  if (!Number.isFinite(payloadMaxTokens) || payloadMaxTokens <= 0 || payloadMaxTokens > safeMaxTokens) {
    return { ...(payload as Record<string, unknown>), [maxTokensField]: safeMaxTokens };
  }

  return payload;
}

/** In-place cap. Frozen objects throw TypeError — caller must wrap in try/catch. */
function applyContextLimitInPlace(model: any, limit: number): boolean {
  if (!model) return false;
  let changed = false;

  if (typeof model.contextWindow === "number" && model.contextWindow > limit) {
    model.contextWindow = limit;
    changed = true;
  }

  const safeMaxTokens = getSafeMaxTokens(model.contextWindow, model.maxTokens);
  if (typeof model.maxTokens === "number" && model.maxTokens > safeMaxTokens) {
    model.maxTokens = safeMaxTokens;
    changed = true;
  }

  return changed;
}

/** Safe in-place cap. Returns true if anything actually changed. */
function applyContextLimit(model: any, limit: number): boolean {
  if (!model || Object.isFrozen(model)) return false;
  try {
    return applyContextLimitInPlace(model, limit);
  } catch {
    return false;
  }
}

/** Debug log to ~/.pi/agent/global-context-limit-debug.log for diagnosis. */
function debugLog(entry: Record<string, unknown>) {
  try {
    const path = join(getAgentDir(), "global-context-limit-debug.log");
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    require("node:fs").appendFileSync(path, line);
  } catch {
    // ignore
  }
}

interface ModelsStoreShape {
  [providerId: string]: {
    models?: Array<{ id: string; contextWindow?: number; maxTokens?: number }>;
  };
}

interface ModelOverride {
  contextWindow?: number;
  maxTokens?: number;
}

interface ModelsJsonShape {
  providers: Record<string, { modelOverrides?: Record<string, ModelOverride> }>;
}

/**
 * Scan extension files for `pi.registerProvider("name", { models: [{ contextWindow: N, ... }] })`
 * calls. The provider config is queued at extension-load time and consumed by
 * bindCore() — the queued config is what gets composed into state.model, so
 * our `pi.registerProvider` monkey-patch on this extension's own `pi` is a
 * no-op for OTHER extensions. The only reliable way to cap an extension-
 * registered model is via a `modelOverrides` entry in models.json applied at
 * compose time.
 *
 * Returns a map of providerId -> modelId -> { contextWindow, maxTokens? }.
 */
function scanExtensionProviders(limit: number): Record<string, Record<string, ModelOverride>> {
  const out: Record<string, Record<string, ModelOverride>> = {};
  const agentDir = getAgentDir();
  const candidates: string[] = [];

  // Built-in extensions dir
  const extDir = join(agentDir, "extensions");
  if (existsSync(extDir)) {
    for (const entry of readdirSync(extDir)) {
      const full = join(extDir, entry);
      try {
        const stat = require("node:fs").statSync(full);
        if (stat.isDirectory()) {
          const idx = join(full, "index.ts");
          if (existsSync(idx)) candidates.push(idx);
        } else if (entry.endsWith(".ts") || entry.endsWith(".js")) {
          candidates.push(full);
        }
      } catch {}
    }
  }

  // npm-installed extensions under ~/.pi/agent/npm/node_modules
  const npmDir = join(agentDir, "npm", "node_modules");
  if (existsSync(npmDir)) {
    for (const entry of readdirSync(npmDir)) {
      if (!entry.startsWith("pi-") && !entry.startsWith("@")) continue;
      const full = join(npmDir, entry);
      try {
        const stat = require("node:fs").statSync(full);
        if (stat.isDirectory()) {
          // Look for the canonical pi extension entry point
          for (const name of ["index.ts", "extensions/index.ts"]) {
            const idx = join(full, name);
            if (existsSync(idx)) {
              candidates.push(idx);
              break;
            }
          }
        }
      } catch {}
    }
  }

  // Match three patterns:
  //   1. `pi.registerProvider("name", { ... })` — literal provider id
  //   2. `pi.registerProvider(name, { ... })` — variable, try to resolve by
  //      looking at the enclosing function (e.g. `function makeProvider(pi, name, ...)`)
  //   3. Any object literal with `models: [{ id: "X", contextWindow: N }]` —
  //      captures ALL extension-registered model definitions, even if the
  //      provider id can't be statically resolved. We then look up the
  //      provider id from a make* factory call adjacent to the register call.
  const literalCallRe = /pi\.registerProvider\s*\(\s*(['"])([a-zA-Z0-9_-]+)\1\s*,\s*\{/g;
  const varCallRe = /pi\.registerProvider\s*\(\s*([a-zA-Z_$][\w$]*)\s*,\s*\{/g;
  const modelEntryRe = /id\s*:\s*(['"])([a-zA-Z0-9._-]+)\1\s*,[\s\S]{0,200}?contextWindow\s*:\s*([0-9_]+)/g;
  const factoryCallRe = /make(?:Provider|Extension)\s*\(\s*[^,]+,\s*(['"])([a-zA-Z0-9_-]+)\1/g;

  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    // Skip our own extension
    if (text.includes("global-context-limit")) continue;

    // First: build provider-id map from factory calls and literal register calls
    const providerIds = new Map<string, string>(); // variable name OR call-position -> provider id
    let m: RegExpExecArray | null;
    literalCallRe.lastIndex = 0;
    while ((m = literalCallRe.exec(text)) !== null) {
      providerIds.set(`call:${m.index}`, m[2]);
    }
    factoryCallRe.lastIndex = 0;
    while ((m = factoryCallRe.exec(text)) !== null) {
      providerIds.set(`factory:${m.index}`, m[2]);
    }

    // Then find all model entries in the file
    modelEntryRe.lastIndex = 0;
    while ((m = modelEntryRe.exec(text)) !== null) {
      const modelId = m[2];
      const contextWindow = parseInt(m[3].replace(/_/g, ""), 10);
      if (typeof contextWindow !== "number" || contextWindow <= limit) continue;

      // Find the enclosing registerProvider call (search backward for the nearest one)
      const before = text.slice(0, m.index);
      const regIdx = before.lastIndexOf("pi.registerProvider");
      if (regIdx === -1) continue;
      const callSig = text.slice(regIdx, m.index);
      // Decide providerId from the call signature
      let providerId: string | undefined;
      const literalInCall = callSig.match(/pi\.registerProvider\s*\(\s*(['"])([a-zA-Z0-9_-]+)\1/);
      if (literalInCall) {
        providerId = literalInCall[2];
      } else {
        // Variable — try to resolve by walking back to the enclosing function param
        // Find the enclosing function: search backward for `function NAME(pi, NAME_VAR, ...)`
        const funcStart = before.lastIndexOf("function");
        if (funcStart !== -1) {
          const funcSig = text.slice(funcStart, regIdx);
          const paramsMatch = funcSig.match(/function\s+\w+\s*\(([^)]*)\)/);
          if (paramsMatch) {
            const params = paramsMatch[1].split(",").map((p) => p.trim().split(/\s*:\s*/)[0]);
            // params[0] is usually `pi`; params[1] is the provider name
            // Extract the argument name used in the call
            const varMatch = callSig.match(/pi\.registerProvider\s*\(\s*([a-zA-Z_$][\w$]*)/);
            if (varMatch) {
              const argName = varMatch[1];
              const idx = params.indexOf(argName);
              if (idx >= 0) {
                // Find factory call: `makeX(pi, "provider", ...)` and use the same index
                const factoryMatch = text.slice(0, funcStart + 200).match(new RegExp(`\\b\\w*Provider\\s*\\(\\s*[^,]+,\\s*(['"])([a-zA-Z0-9_-]+)\\1`));
                if (factoryMatch) providerId = factoryMatch[2];
              }
            }
          }
        }
        if (!providerId) {
          // Last resort: look for any factory call anywhere in the file that takes a string literal as the second arg
          const allFactories = [...text.matchAll(/\w*Provider\s*\(\s*[^,]+,\s*(['"])([a-zA-Z0-9_-]+)\1/g)];
          if (allFactories.length > 0) providerId = allFactories[0][2];
        }
      }

      if (!providerId) continue;
      if (!out[providerId]) out[providerId] = {};
      out[providerId][modelId] = { contextWindow: limit };
    }
  }

  return out;
}

/**
 * Scan models-store.json for any model whose native contextWindow exceeds the
 * limit, and write corresponding `modelOverrides` entries into models.json so
 * pi loads them at startup (before the deepFreeze).
 *
 * Idempotent: re-running with the same limit produces the same file.
 *
 * Returns { scanned, written, skipped } so callers can report.
 */
function rebuildModelOverrides(limit: number): { scanned: number; written: number; skipped: number; error?: string } {
  const storePath = getModelsStorePath();
  if (!existsSync(storePath)) {
    return { scanned: 0, written: 0, skipped: 0, error: `models-store.json not found at ${storePath}` };
  }

  let store: ModelsStoreShape;
  try {
    store = JSON.parse(readFileSync(storePath, "utf-8"));
  } catch (e) {
    return { scanned: 0, written: 0, skipped: 0, error: `Failed to parse models-store.json: ${(e as Error).message}` };
  }

  // Build desired overrides from store
  const desired: Record<string, Record<string, ModelOverride>> = {};
  let scanned = 0;
  for (const [providerId, cfg] of Object.entries(store)) {
    if (!cfg?.models) continue;
    for (const model of cfg.models) {
      scanned++;
      const cw = model.contextWindow;
      if (typeof cw !== "number" || cw <= limit) continue;
      if (!desired[providerId]) desired[providerId] = {};
      const override: ModelOverride = { contextWindow: limit };
      if (typeof model.maxTokens === "number" && model.maxTokens > limit) {
        // Keep maxTokens proportional but not larger than the new contextWindow
        override.maxTokens = Math.min(model.maxTokens, getSafeMaxTokens(limit));
      }
      desired[providerId][model.id] = override;
    }
  }

  // Also scan extension-registered providers. These bypass the models-store
  // freeze because pi composes them from the extension's queued config, but
  // a modelOverrides entry in models.json still applies at compose time.
  try {
    const fromExtensions = scanExtensionProviders(limit);
    for (const [providerId, modelOverrides] of Object.entries(fromExtensions)) {
      if (!desired[providerId]) desired[providerId] = {};
      for (const [modelId, override] of Object.entries(modelOverrides)) {
        desired[providerId][modelId] = override;
        scanned++;
      }
    }
  } catch (e) {
    // Best-effort — if extension scan fails, native overrides still work.
  }

  // Read existing models.json
  const modelsPath = getModelsPath();
  let existing: ModelsJsonShape = { providers: {} };
  if (existsSync(modelsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(modelsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
        existing = parsed;
      }
    } catch {
      // Corrupt file — back it up and start fresh.
      try {
        writeFileSync(modelsPath + ".corrupt-" + Date.now(), readFileSync(modelsPath));
      } catch {}
      existing = { providers: {} };
    }
  }

  // Reconcile: keep non-`globalContextLimit` overrides as-is, replace ours.
  let written = 0;
  let skipped = 0;
  for (const [providerId, modelOverrides] of Object.entries(desired)) {
    if (!existing.providers[providerId]) existing.providers[providerId] = {};
    const prov = existing.providers[providerId];
    if (!prov.modelOverrides) prov.modelOverrides = {};

    for (const [modelId, newOverride] of Object.entries(modelOverrides)) {
      const prev = prov.modelOverrides[modelId];
      if (
        prev &&
        prev.contextWindow === newOverride.contextWindow &&
        prev.maxTokens === newOverride.maxTokens
      ) {
        skipped++;
        continue;
      }
      prov.modelOverrides[modelId] = newOverride;
      written++;
    }

    // Drop override entries for models that no longer need one (e.g. user raised the limit)
    // so users can disable the cap by clearing globalContextLimit and running rebuild.
    for (const modelId of Object.keys(prov.modelOverrides)) {
      if (modelOverrides[modelId]) continue;
      if (prov.modelOverrides[modelId]?.contextWindow === limit) {
        delete prov.modelOverrides[modelId];
      }
    }
    if (Object.keys(prov.modelOverrides).length === 0) {
      delete prov.modelOverrides;
    }
    if (Object.keys(prov).length === 0) {
      delete existing.providers[providerId];
    }
  }

  // Drop provider entries that have nothing left.
  for (const providerId of Object.keys(existing.providers)) {
    const prov = existing.providers[providerId];
    if (Object.keys(prov).length === 0) delete existing.providers[providerId];
  }

  try {
    if (Object.keys(existing.providers).length === 0) {
      // Nothing left to write — remove the file so we don't leave stale overrides behind.
      try {
        const fs = require("node:fs");
        fs.unlinkSync(modelsPath);
      } catch {}
      return { scanned, written, skipped };
    }
    writeFileSync(modelsPath, JSON.stringify(existing, null, 2) + "\n");
  } catch (e) {
    return { scanned, written, skipped, error: `Failed to write models.json: ${(e as Error).message}` };
  }

  return { scanned, written, skipped };
}

export default function (pi: ExtensionAPI) {
  let globalLimit: number | null = readGlobalContextLimit();
  let lastRebuild: { scanned: number; written: number; skipped: number; error?: string } | null = null;

  // ------------------------------------------------------------------
  // Pre-load: write models.json with modelOverrides so frozen providers
  // (everything loaded from models-store.json) get the cap at load time.
  // ------------------------------------------------------------------
  if (globalLimit !== null) {
    try {
      lastRebuild = rebuildModelOverrides(globalLimit);
    } catch (e) {
      lastRebuild = { scanned: 0, written: 0, skipped: 0, error: (e as Error).message };
    }
  }

  if (globalLimit !== null) {
    // Mutation fallback for extension-registered providers (e.g.
    // pi-minimax-m3-caching-fix). pi.registerProvider is a stub during
    // extension loading — it pushes to a pending queue that's flushed at
    // bindCore(). Mutating the config.models entries BEFORE queuing means
    // the composed provider picks up the capped values.
    const originalRegisterProvider = pi.registerProvider.bind(pi);

    pi.registerProvider = function (name: string, config: any) {
      if (config?.models && Array.isArray(config.models)) {
        config.models = config.models.map((model: any) => {
          const before = model.contextWindow;
          const changed = applyContextLimit(model, globalLimit!);
          debugLog({ where: "registerProvider", provider: name, id: model.id, before, after: model.contextWindow, changed, frozen: Object.isFrozen(model) });
          return model;
        });
      }
      return originalRegisterProvider(name, config);
    } as any;

    // Cap the serialized provider payload. pi's openai-completions stack does
    // not automatically pass model.maxTokens, so some providers use a large
    // default output budget and can overshoot long contexts.
    pi.on("before_provider_request", (event, ctx) => {
      if (!ctx.model) return;
      debugLog({ where: "before_provider_request", provider: ctx.model.provider, id: ctx.model.id, contextWindow: ctx.model.contextWindow, frozen: Object.isFrozen(ctx.model) });
      return capPayloadMaxTokens(event.payload, ctx.model);
    });

    // Snapshot state.model.contextWindow just before the agent starts
    // running, so we can see if something between session_start and the
    // first agent run resets state.model.
    pi.on("agent_start", async (_event, ctx) => {
      if (ctx.model) {
        debugLog({ where: "agent_start", provider: ctx.model.provider, id: ctx.model.id, contextWindow: ctx.model.contextWindow, frozen: Object.isFrozen(ctx.model) });
      }
    });
  }

  // Re-apply on model selection to catch any models that slip through
  pi.on("model_select", async (event, ctx) => {
    if (globalLimit === null) globalLimit = readGlobalContextLimit();
    if (globalLimit !== null && event.model) {
      const before = event.model.contextWindow;
      applyContextLimit(event.model, globalLimit);
      const after = event.model.contextWindow;
      debugLog({ where: "model_select", provider: event.model.provider, id: event.model.id, before, after, frozen: Object.isFrozen(event.model) });
    }
  });

  // Apply on session start
  pi.on("session_start", async (_event, ctx) => {
    globalLimit = readGlobalContextLimit();

    if (globalLimit !== null && ctx.model) {
      const before = ctx.model.contextWindow;
      const changed = applyContextLimit(ctx.model, globalLimit);
      const after = ctx.model.contextWindow;
      debugLog({ where: "session_start", provider: ctx.model.provider, id: ctx.model.id, before, after, frozen: Object.isFrozen(ctx.model), changed });
    }

    // Skip the registry refresh for now — it might be the culprit that resets
    // state.model. Re-enable after we figure out the right place.
  });

  // Log the limit on startup
  pi.on("session_start", async (_event, ctx) => {
    if (globalLimit !== null) {
      const detail = lastRebuild
        ? lastRebuild.error
          ? ` (rebuild error: ${lastRebuild.error})`
          : ` — models.json: ${lastRebuild.written} override${lastRebuild.written === 1 ? "" : "s"} written, ${lastRebuild.scanned} models scanned`
        : "";
      ctx.ui.notify(`Global context limit: ${globalLimit.toLocaleString()} tokens${detail}. Re-select your model (or /reload) to apply.`, "info");
    }
  });

  // /context-limit command
  pi.registerCommand("context-limit", {
    description: "Show or set global context limit. Subcommands: rebuild, clear, <N>",
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (trimmed === "rebuild") {
        const limit = globalLimit ?? readGlobalContextLimit();
        if (limit === null) {
          ctx.ui.notify("No globalContextLimit set in settings.json — nothing to rebuild", "error");
          return;
        }
        const result = rebuildModelOverrides(limit);
        if (result.error) {
          ctx.ui.notify(`Rebuild failed: ${result.error}`, "error");
          return;
        }
        ctx.ui.notify(
          `models.json: ${result.written} override${result.written === 1 ? "" : "s"} written, ${result.skipped} unchanged, ${result.scanned} models scanned. Run /reload to apply.`,
          "info",
        );
        return;
      }

      if (trimmed === "clear") {
        const settingsPath = getSettingsPath();
        if (existsSync(settingsPath)) {
          try {
            const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
            delete settings.globalContextLimit;
            writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          } catch {}
        }
        globalLimit = null;
        // Drop all generated overrides from models.json
        const modelsPath = getModelsPath();
        if (existsSync(modelsPath)) {
          try {
            const mj: ModelsJsonShape = JSON.parse(readFileSync(modelsPath, "utf-8"));
            if (mj && typeof mj === "object" && mj.providers && typeof mj.providers === "object") {
              for (const [provKey, prov] of Object.entries(mj.providers)) {
                if (prov.modelOverrides) {
                  for (const k of Object.keys(prov.modelOverrides)) {
                    delete prov.modelOverrides[k];
                  }
                  if (Object.keys(prov.modelOverrides).length === 0) delete prov.modelOverrides;
                }
                if (Object.keys(prov).length === 0) delete mj.providers[provKey];
              }
              if (Object.keys(mj.providers).length === 0) {
                try { require("node:fs").unlinkSync(modelsPath); } catch {}
              } else {
                writeFileSync(modelsPath, JSON.stringify(mj, null, 2) + "\n");
              }
            }
          } catch {}
        }
        ctx.ui.notify("Global context limit cleared. Run /reload to apply.", "info");
        return;
      }

      if (!trimmed) {
        const current = readGlobalContextLimit();
        ctx.ui.notify(
          current
            ? `Global context limit: ${current.toLocaleString()} tokens`
            : "No global context limit set",
          "info",
        );
        return;
      }

      const value = parseInt(trimmed, 10);
      if (isNaN(value) || value < 1000) {
        ctx.ui.notify("Invalid limit. Must be a number >= 1000", "error");
        return;
      }

      // Update settings.json
      const settingsPath = getSettingsPath();
      let settings: any = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        } catch {
          settings = {};
        }
      }

      settings.globalContextLimit = value;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

      globalLimit = value;
      const result = rebuildModelOverrides(value);

      // Apply to current model
      if (ctx.model) {
        applyContextLimit(ctx.model, value);
      }

      ctx.ui.notify(
        `Global context limit set to ${value.toLocaleString()} tokens — ${result.written} model${result.written === 1 ? "" : "s"} override${result.written === 1 ? "" : "s"} written. Run /reload to apply.`,
        "info",
      );
    },
  });
}
