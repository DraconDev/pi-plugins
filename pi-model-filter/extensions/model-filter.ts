/**
 * pi-model-filter
 *
 * Hides superseded version-suffixed models from pi's /model selector,
 * Ctrl+P model cycling, and the --models CLI scope. Works across every
 * provider — built-in, models.json, and extension-registered.
 *
 * Version detection
 *   A model id groups under its "base name" = everything before the
 *   rightmost run of purely numeric hyphen-separated segments:
 *
 *     "agnes-2.0"         → base "agnes",         version "2.0"
 *     "agnes-3.0"         → base "agnes",         version "3.0"
 *     "gpt-5.5"           → base "gpt",           version "5.5"
 *     "claude-sonnet-4-5" → base "claude-sonnet", version "4.5"
 *     "my-model"          → no version, never filtered
 *
 *   Within each provider:base group only the numerically highest
 *   version survives. Models without a numeric version tail are
 *   singletons and always shown.
 *
 * Design boundary: ids ending in a non-numeric qualifier are NOT
 * treated as versioned. "agnes-2.5-flash" and "agnes-3.0-flash" are
 * singletons and both stay visible. If a provider ships both "-flash"
 * variants at once, use /model-filter keep to pin the one you want.
 *
 * How it's wired in
 *   A provider-owning extension (like pi-agnes-tools) can add:
 *
 *       import { filterModelList, loadConfigFor, getAgentDir } from
 *         "pi-model-filter/extensions/model-filter";
 *
 *       // when registering the provider, wrap the model list and the
 *       // refreshModels callback:
 *       models: filterModelList(AGNES_SEED.map(toModelConfig), "agnes",
 *         new Set(loadConfigFor(getAgentDir()).keep),
 *         loadConfigFor(getAgentDir()).disabled),
 *       refreshModels: wrapRefreshModels(originalRefresh, "agnes"),
 *
 *   This extension also ships a standalone fallback: if a provider
 *   re-registers itself via this plugin's patched registerProvider,
 *   its models/refreshModels are filtered automatically. Because every
 *   extension receives its own `pi` object, this patching only catches
 *   registrations that flow through THIS extension's `pi`, so the
 *   primary integration is the explicit import above.
 *
 *   Config file: ~/.pi/agent/model-filter.json
 *   {
 *     "disabled": false,
 *     "keep": ["agnes/agnes-2.0-flash"]
 *   }
 *
 * Commands
 *   /model-filter status        – show current state
 *   /model-filter enable|disable
 *   /model-filter keep <id>    – protect a model from filtering
 *   /model-filter unkeep <id>
 *
 * Config changes persist immediately; call sites that capture the config
 * at registration time re-apply on the next /reload or new session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface FilterConfig {
  version: 1;
  disabled: boolean;
  /** "provider/model-id" entries that must survive filtering. */
  keep: string[];
}

export const DEFAULT_CONFIG: FilterConfig = { version: 1, disabled: false, keep: [] };

export type ModelDef = Record<string, unknown> & { id: string; name?: string };
export type RefreshModelsFn = (ctx: unknown) => Promise<ModelDef[] | undefined | null>;

// ─── Config I/O ─────────────────────────────────────────────────────────────

export function configPathFor(agentDir: string): string {
  return join(agentDir, "model-filter.json");
}

export function loadConfigFor(agentDir: string): FilterConfig {
  try {
    const p = configPathFor(agentDir);
    if (!existsSync(p)) return { ...DEFAULT_CONFIG, keep: [] };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<FilterConfig>;
    return {
      version: 1,
      disabled: raw.disabled ?? false,
      keep: Array.isArray(raw.keep) ? raw.keep : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG, keep: [] };
  }
}

export function saveConfigFor(agentDir: string, cfg: FilterConfig): void {
  try {
    const p = configPathFor(agentDir);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2));
  } catch {
    // non-fatal
  }
}

// ─── Version parsing ────────────────────────────────────────────────────────

export function splitVersion(
  id: string,
): { base: string; version: string } | null {
  const parts = id.split("-");
  if (parts.length < 2) return null;

  let i = parts.length - 1;
  const last = parts[i];
  let isIntegerRunStart: number;

  if (/^\d+$/.test(last)) {
    isIntegerRunStart = i;
    while (isIntegerRunStart > 0 && /^\d+$/.test(parts[isIntegerRunStart - 1])) {
      isIntegerRunStart--;
    }
  } else if (/^\d+\.\d+$/.test(last)) {
    isIntegerRunStart = i;
  } else {
    return null; // trailing non-numeric qualifier → not a version token
  }

  const base = parts.slice(0, isIntegerRunStart).join("-");
  if (!base) return null;
  const version = parts.slice(isIntegerRunStart).join(".");
  return { base, version };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number(s) || 0);
  const pb = b.split(".").map((s) => Number(s) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

// ─── Core filter ────────────────────────────────────────────────────────────

/**
 * Filter a flat array of model definitions. Within each
 * provider:base group only the numerically highest version survives.
 * `keepSet` contains fully-qualified "provider/id" strings that must
 * always survive. Returns the input array unchanged when `disabled`.
 */
export function filterModelList(
  models: ModelDef[],
  provider: string,
  keepSet: ReadonlySet<string>,
  disabled: boolean,
): ModelDef[] {
  if (disabled) return models;
  if (models.length === 0) return models;

  interface Group {
    key: string;
    winner: ModelDef;
    winnerVersion: string | null;
    members: ModelDef[];
  }

  const groups = new Map<string, Group>();

  for (const m of models) {
    const sv = splitVersion(m.id);
    const groupKey = sv ? `${provider}:${sv.base}` : `${provider}:${m.id}::__singleton__`;

    let g = groups.get(groupKey);
    if (!g) {
      g = { key: groupKey, winner: m, winnerVersion: sv?.version ?? null, members: [] };
      groups.set(groupKey, g);
    }
    g.members.push(m);

    if (sv) {
      const cmp = g.winnerVersion === null ? 1 : compareVersions(sv.version, g.winnerVersion);
      if (cmp > 0) {
        g.winner = m;
        g.winnerVersion = sv.version;
      }
    }
  }

  const result: ModelDef[] = [];
  const included = new Set<ModelDef>();

  for (const g of groups.values()) {
    for (const m of g.members) {
      const fq = `${provider}/${m.id}`;
      if (keepSet.has(fq) && !included.has(m)) {
        result.push(m);
        included.add(m);
      }
    }
    if (!included.has(g.winner)) {
      result.push(g.winner);
      included.add(g.winner);
    }
  }

  const orderMap = new Map(models.map((m, i) => [m, i]));
  result.sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0));

  return result;
}

// ─── Integration helpers (exported for provider-owning extensions) ─────────

/**
 * Wrap an existing `refreshModels` callback so its returned model list
 * is filtered through the current config each time it runs. Returns
 * the original when `original` is undefined.
 */
export function wrapRefreshModels(
  original: RefreshModelsFn | undefined,
  provider: string,
): RefreshModelsFn | undefined {
  if (!original) return original;
  return (async (ctx: unknown) => {
    const result = await original(ctx);
    if (!result) return result;
    const cfg = loadConfigFor(getAgentDir());
    return filterModelList(result, provider, new Set(cfg.keep), cfg.disabled);
  }) as RefreshModelsFn;
}

/**
 * Convenience: filter a static model list using the live config on disk.
 */
export function filterModelsForProvider(models: ModelDef[], provider: string): ModelDef[] {
  const cfg = loadConfigFor(getAgentDir());
  return filterModelList(models, provider, new Set(cfg.keep), cfg.disabled);
}

// ─── Provider interception (standalone fallback) ───────────────────────────

interface PatchablePi {
  registerProvider(providerOrName: string | unknown, config?: unknown): void;
  registerNativeProvider?(provider: unknown): void;
}

/**
 * Patch the pi object so every provider registration made through it
 * goes through the version filter. Idempotent.
 *
 * Caveat: each extension receives its own `pi` object from the loader,
 * so patching this object only affects registrations that flow through
 * THIS extension's api. Use the explicit import helpers above for
 * reliable cross-extension filtering.
 */
export function patchPi(
  pi: PatchablePi,
  getCfg: () => FilterConfig,
): void {
  const anyPi = pi as Record<string, unknown>;
  if (anyPi.__modelFilterPatched) return;
  anyPi.__modelFilterPatched = true;

  const originalRegisterProvider = pi.registerProvider.bind(pi);
  const originalRegisterNative =
    typeof pi.registerNativeProvider === "function"
      ? pi.registerNativeProvider.bind(pi)
      : undefined;

  pi.registerProvider = (providerOrName: string | unknown, config?: unknown) => {
    const providerName: string =
      typeof providerOrName === "string"
        ? providerOrName
        : ((providerOrName as Record<string, unknown>)?.id as string) ?? "unknown";

    // Legacy form: pi.registerProvider("name", { models, refreshModels })
    if (typeof providerOrName === "string" && config !== undefined) {
      const c = { ...(config as Record<string, unknown>) };
      const cfg = getCfg();
      if (Array.isArray(c.models)) {
        c.models = filterModelList(
          c.models as ModelDef[],
          providerName,
          new Set(cfg.keep),
          cfg.disabled,
        );
      }
      if (typeof c.refreshModels === "function") {
        const originalRefresh = c.refreshModels as RefreshModelsFn;
        c.refreshModels = (async (ctx: unknown) => {
          const result = await originalRefresh(ctx);
          if (!result) return result;
          const cfgNow = getCfg();
          return filterModelList(result, providerName, new Set(cfgNow.keep), cfgNow.disabled);
        }) as RefreshModelsFn;
      }
      return originalRegisterProvider(providerOrName, c);
    }

    // Native Provider object form – wrap getModels()
    const p = providerOrName as Record<string, unknown>;
    if (p && typeof p.getModels === "function") {
      const originalGetModels = p.getModels.bind(p);
      const wrapped: Record<string, unknown> = { ...p };
      wrapped.getModels = () => {
        const models = originalGetModels() as ModelDef[];
        const cfg = getCfg();
        return filterModelList(models, providerName, new Set(cfg.keep), cfg.disabled);
      };
      return originalRegisterProvider(wrapped);
    }

    return originalRegisterProvider(providerOrName, config);
  };

  if (originalRegisterNative) {
    pi.registerNativeProvider = (provider: unknown) => {
      const p = provider as Record<string, unknown>;
      const providerName: string = (p?.id as string) ?? "unknown";
      if (p && typeof p.getModels === "function") {
        const originalGetModels = p.getModels.bind(p);
        const wrapped: Record<string, unknown> = { ...p };
        wrapped.getModels = () => {
          const models = originalGetModels() as ModelDef[];
          const cfg = getCfg();
          return filterModelList(models, providerName, new Set(cfg.keep), cfg.disabled);
        };
        return originalRegisterNative(wrapped);
      }
      return originalRegisterNative(provider);
    };
  }
}

// ─── Extension entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let cfg: FilterConfig = loadConfigFor(getAgentDir());

  function getCfg(): FilterConfig {
    return cfg;
  }

  function refreshConfig() {
    cfg = loadConfigFor(getAgentDir());
  }

  // Standalone fallback: patch this extension's own pi object so that
  // any provider registered through it gets filtered. Cross-extension
  // filtering is achieved by the importing extension using the helpers
  // above (filterModelsForProvider / wrapRefreshModels).
  try {
    patchPi(pi as unknown as PatchablePi, getCfg);
  } catch {
    // never block extension loading
  }

  pi.registerCommand("model-filter", {
    description: "Configure the model version filter (hide superseded versions)",
    handler: async (args: string, ctx: any) => {
      const action = args.trim();
      const notify = (msg: string, type = "info") => ctx.ui.notify?.(msg, type);
      const dir = getAgentDir();

      switch (action) {
        case "":
        case "status": {
          const lines = [
            `Filter: ${cfg.disabled ? "DISABLED" : "active"}`,
            `Kept models: ${cfg.keep.length === 0 ? "(none)" : cfg.keep.join(", ")}`,
            "Config is read live by provider refresh callbacks.",
            "Static model lists re-apply on the next /reload or session.",
          ];
          notify(lines.join("\n"));
          break;
        }
        case "enable": {
          cfg.disabled = false;
          saveConfigFor(dir, cfg);
          refreshConfig();
          notify("model-filter: enabled. Refresh callbacks pick it up on next model refresh.");
          break;
        }
        case "disable": {
          cfg.disabled = true;
          saveConfigFor(dir, cfg);
          refreshConfig();
          notify("model-filter: disabled. Refresh callbacks pick it up on next model refresh.");
          break;
        }
        case "keep": {
          const parts = action.split(" ");
          const id = parts.slice(1).join(" ").trim();
          if (!id) {
            notify("Usage: /model-filter keep <provider/model-id>", "warn");
            break;
          }
          if (!cfg.keep.includes(id)) cfg.keep.push(id);
          saveConfigFor(dir, cfg);
          refreshConfig();
          notify(`model-filter: keeping ${id}. Refresh callbacks pick it up on next model refresh.`);
          break;
        }
        case "unkeep": {
          const parts = action.split(" ");
          const id = parts.slice(1).join(" ").trim();
          if (!id) {
            notify("Usage: /model-filter unkeep <provider/model-id>", "warn");
            break;
          }
          cfg.keep = cfg.keep.filter((k) => k !== id);
          saveConfigFor(dir, cfg);
          refreshConfig();
          notify(`model-filter: released ${id}. Refresh callbacks pick it up on next model refresh.`);
          break;
        }
        default:
          notify(
            [
              "Usage:",
              "  /model-filter status",
              "  /model-filter enable | disable",
              "  /model-filter keep <provider/model-id>",
              "  /model-filter unkeep <provider/model-id>",
            ].join("\n"),
            "warn",
          );
      }
    },
  });
}
