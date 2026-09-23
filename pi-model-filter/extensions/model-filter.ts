/**
 * pi-model-filter
 *
 * Hides superseded version-suffixed models from pi's /model selector,
 * Ctrl+P model cycling, and the --models CLI scope.
 *
 * How it works
 *   Models are grouped by `${provider}:${base}` where `base` is the model
 *   id with the trailing version token stripped. A version token is the
 *   rightmost run of purely numeric hyphen-separated segments in the id:
 *
 *     "agnes-2.5-flash"    → base "agnes",       version "2.5"
 *     "agnes-3.0-flash"    → base "agnes",       version "3.0"
 *     "agnes-2.0"          → base "agnes",       version "2.0"
 *     "claude-sonnet-4-5"  → base "claude-sonnet", version "4.5"
 *     "my-model"           → no version (never filtered)
 *
 *   Within each group only the highest version is kept. Models that have
 *   no numeric version token (e.g. "claude-haiku", "gpt-codex") are
 *   singletons and always survive.
 *
 *   The filter is applied by patching `registerProvider` /
 *   `registerNativeProvider` on the extension context's `pi` object at
 *   `session_start` (which runs after all extension factories, but before
 *   the session's first model refresh). The wrapped `models` arrays and
 *   `refreshModels` callbacks are filtered in place, so both the static
 *   catalog and live /v1/models discovery are covered.
 *
 * Config file: ~/.pi/agent/model-filter.json
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
 * Note: changing keep/disable persists immediately; the filtered catalog
 * re-applies on the next /reload or new session because that is when
 * session_start re-runs and the provider registration is re-wrapped.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

const DEFAULT_CONFIG: FilterConfig = { version: 1, disabled: false, keep: [] };

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

  // Find the rightmost run of integer parts; a trailing dotted token
  // ("2.5") also counts as a single version part.
  let i = parts.length - 1;
  const last = parts[i];

  let isIntegerRunStart: number; // index of first integer in the tail run

  if (/^\d+$/.test(last)) {
    // Tail is a plain integer; walk left while integers continue.
    isIntegerRunStart = i;
    while (isIntegerRunStart > 0 && /^\d+$/.test(parts[isIntegerRunStart - 1])) {
      isIntegerRunStart--;
    }
  } else if (/^\d+\.\d+$/.test(last)) {
    // Tail is a dotted version ("2.5"). The integer before it ("2" in
    // "agnes-2-2.5"? unusual, but treat as part of version).
    isIntegerRunStart = i;
  } else {
    return null; // no version token at the tail
  }

  const base = parts.slice(0, isIntegerRunStart).join("-");
  if (!base) return null; // entire id is numeric → not a model we know
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

// ─── Provider interception ─────────────────────────────────────────────────

function wrapRefreshModels(
  original: RefreshModelsFn | undefined,
  provider: string,
  getCfg: () => FilterConfig,
): RefreshModelsFn | undefined {
  if (!original) return original;
  return (async (ctx: unknown) => {
    const result = await original(ctx);
    if (!result) return result;
    const cfg = getCfg();
    return filterModelList(result, provider, new Set(cfg.keep), cfg.disabled);
  }) as RefreshModelsFn;
}

interface PatchablePi {
  registerProvider(providerOrName: string | unknown, config?: unknown): void;
  registerNativeProvider?(provider: unknown): void;
  unregisterProvider?(name: string): void;
}

/**
 * Patch the pi object so that every provider registration made AFTER this
 * call (including by other extensions that registered earlier, when their
 * refreshModels is later invoked) goes through the version filter.
 *
 * Idempotent: re-patching an already-patched object is a no-op.
 */
export function patchPi(
  pi: PatchablePi,
  getCfg: () => FilterConfig,
): void {
  const anyPi = pi as any;
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
        c.refreshModels = wrapRefreshModels(
          c.refreshModels as RefreshModelsFn,
          providerName,
          getCfg,
        );
      }
      return originalRegisterProvider(providerOrName, c);
    }

    // Native Provider object form – models live inside provider.getModels();
    // we wrap the object in a Proxy-less shallow copy with filtered
    // getModels().
    const p = providerOrName as Record<string, unknown>;
    if (p && typeof p.getModels === "function") {
      const wrapped = { ...p };
      const originalGetModels = p.getModels.bind(p);
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
      const providerName = ((p?.id as string) ?? "unknown");
      if (p && typeof p.getModels === "function") {
        const wrapped = { ...p };
        const originalGetModels = p.getModels.bind(p);
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

  function refreshConfig() {
    cfg = loadConfigFor(getAgentDir());
  }

  // Patch at session_start: all extension factories have already run, so
  // re-registering is the only moment when provider registration flows
  // through a still-active extension context. Also safe to re-patch on
  // /reload because patchPi() is idempotent.
  pi.on("session_start", (event, ctx: ExtensionContext) => {
    try {
      patchPi(ctx as unknown as PatchablePi, () => cfg);
    } catch {
      // never block session start
    }
  });

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
            "Note: config changes apply to the next /reload or session",
          ];
          notify(lines.join("\n"));
          break;
        }
        case "enable": {
          cfg.disabled = false;
          saveConfigFor(dir, cfg);
          refreshConfig();
          notify("model-filter: enabled. Run /reload to re-apply to all providers.");
          break;
        }
        case "disable": {
          cfg.disabled = true;
          saveConfigFor(dir, cfg);
          refreshConfig();
          notify("model-filter: disabled. Run /reload to re-apply to all providers.");
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
          notify(`model-filter: keeping ${id}. Run /reload to re-apply.`);
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
          notify(`model-filter: released ${id}. Run /reload to re-apply.`);
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
