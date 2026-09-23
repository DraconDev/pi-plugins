/**
 * pi-model-filter
 *
 * Hides superseded version-suffixed models from pi's /model selector,
 * Ctrl+P model cycling, and the --models CLI.
 *
 * How it works
 *   Models are grouped by `${provider}:${base}` where `base` is the model
 *   id with the trailing version + qualifier stripped
 *   (`agnes-2.5-flash` → base `agnes`, version `2.5`, qualifier `flash`).
 *   When a group has more than one versioned member, only the highest
 *   version is kept. Models without a numeric version token are never
 *   filtered.
 *
 * The filter is applied by intercepting `pi.registerProvider` before other
 *   1. Wrap `config.models` (the static catalog array)
 *   2. Wrap `config.refreshModels` (dynamic discovery callback)
 *
 * Config file: ~/.pi/agent/model-filter.json
 *   {
 *     "disabled": false,
 *     "keep": ["agnes/agnes-2.0-flash"]
 *   }
 *
 * Commands
 *   /model-filter status       – show current state
 *   /model-filter enable|disable
 *   /model-filter keep <id>   – protect a model from filtering
 *   /model-filter unkeep <id>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

// ─── Types ─────────────────────────────────────────────────────────────────

interface FilterConfig {
  version: 1;
  disabled: boolean;
  /** "provider/model-id" entries that must survive filtering. */
  keep: string[];
}

const DEFAULT_CONFIG: FilterConfig = { version: 1, disabled: false, keep: [] };

// ─── Config I/O ─────────────────────────────────────────────────────────────

function configPath(): string {
  return join(getAgentDir(), "model-filter.json");
}

function loadConfig(): FilterConfig {
  try {
    const p = configPath();
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

function saveConfig(cfg: FilterConfig): void {
  try {
    const p = configPath();
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2));
  } catch {
    // non-fatal
  }
}

// ─── Version parsing ────────────────────────────────────────────────────────

/**
 * Extract the version token from a model id.
 *
 *   "agnes-2.5-flash"  → base "agnes", version "2.5", qualifier "flash"
 *   "agnes-2.0"        → base "agnes", version "2.0", qualifier undefined
 *   "gpt-5.5"          → base "gpt",   version "5.5", qualifier undefined
 *   "claude-sonnet-4-5"→ base "claude-sonnet", version "4.5", qualifier undefined
 *   "my-model"         → null
 *
 * A model is versioned when it contains a `-<digits>` or
 * `-<digits>.<digits>` token anywhere in the id. The base is everything
 * before that first numeric segment, and the version is the numeric
 * token (plus any following non-numeric qualifier segments, ignored
 * for comparison purposes).
 */
function splitVersion(id: string): { base: string; version: string } | null {
  const parts = id.split("-");
  if (parts.length < 2) return null;

  // Find the first part that is purely numeric (e.g. "2" in "2.5" or "4" in "4-5").
  // The base ends at the last non-numeric part before that digit run.
  // We want the LAST version-looking segment, not the first — e.g.
  // "agnes-2.0" has one numeric tail; "claude-sonnet-4-5" has two numeric tails.
  //
  // Strategy: scan from the right. Collect the rightmost run of parts
  // that are integers. That run forms the version (dots-joined). The
  // part immediately before the run must be non-numeric (otherwise the
  // model has no base, e.g. "4-5" alone).

  let i = parts.length - 1;
  if (!/^\d+$/.test(parts[i])) {
    // Last part is not an integer → could be "2.5" (dotted).
    // Try to find a dotted version as the last part.
    const m = parts[i].match(/^(\d+)\.(\d+)$/);
    if (!m) return null;
    // base = parts[0..i-1], version = parts[i]
    const base = parts.slice(0, i).join("-");
    if (!base) return null;
    return { base, version: parts[i] };
  }

  // parts[i] is an integer. Walk left while parts are integers.
  let j = i;
  while (j > 0 && /^\d+$/.test(parts[j - 1])) j--;

  // parts[j..i] are all integers → version = those joined with "."
  // But we must stop before a non-integer, so j is the first non-integer
  // (or 0).
  const base = parts.slice(0, j).join("-");
  if (!base) return null;
  const version = parts.slice(j, i + 1).join(".");
  return { base, version };
}

/** Compare two dot-separated version strings numerically. */
function compareVersions(a: string, b: string): number {
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

type ModelDef = Record<string, unknown> & { id: string; name?: string };

/**
 * Filter a flat array of model definitions (from registerProvider or
 * refreshModels). `keepSet` contains fully-qualified "provider/id"
 * strings that must always survive.
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
    winnerVersion: string | null; // null = no version → singleton
    members: ModelDef[];
  }

  const groups = new Map<string, Group>();

  for (const m of models) {
    const sv = splitVersion(m.id);
    // Singleton key when no version → group of one, never filtered.
    const groupKey = sv ? `${provider}:${sv.base}` : `${provider}:${m.id}::__singleton__`;

    let g = groups.get(groupKey);
    if (!g) {
      g = { key: groupKey, winner: m, winnerVersion: sv?.version ?? null, members: [] };
      groups.set(groupKey, g);
    }
    g.members.push(m);

    // Update winner
    if (sv) {
      const cmp = g.winnerVersion === null ? 1 : compareVersions(sv.version, g.winnerVersion);
      if (cmp > 0) {
        g.winner = m;
        g.winnerVersion = sv.version;
      }
    }
    // No-version models can never beat a versioned winner.
  }

  const result: ModelDef[] = [];
  const included = new Set<ModelDef>();

  for (const g of groups.values()) {
    // Always include explicitly kept models
    for (const m of g.members) {
      const fq = `${provider}/${m.id}`;
      if (keepSet.has(fq) && !included.has(m)) {
        result.push(m);
        included.add(m);
      }
    }
    // Include the group winner unless already included
    if (!included.has(g.winner)) {
      result.push(g.winner);
      included.add(g.winner);
    }
  }

  // Preserve original order
  const orderMap = new Map(models.map((m, i) => [m, i]));
  result.sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0));

  return result;
}

// ─── Provider interception ─────────────────────────────────────────────────

function wrapRefreshModels(
  original: ((ctx: any) => Promise<ModelDef[] | undefined>) | undefined,
  provider: string,
  getCfg: () => FilterConfig,
): ((ctx: any) => Promise<ModelDef[] | undefined>) | undefined {
  if (!original) return original;
  return async (ctx: any) => {
    const result = await original(ctx);
    if (!result) return result;
    const cfg = getCfg();
    const keepSet = new Set(cfg.keep);
    return filterModelList(result, provider, keepSet, cfg.disabled);
  };
}

// ─── Extension entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let cfg: FilterConfig = loadConfig();

  function refreshConfig() {
    cfg = loadConfig();
  }

  function keepSet(): Set<string> {
    return new Set(cfg.keep);
  }

  // ── Intercept registerProvider to wrap models + refreshModels ──────
  // pi calls extension factories in load order. By patching
  // `pi.registerProvider` at the very start of this factory, we ensure
  // that when our patch is in place, subsequent calls from other
  // extensions (or pi's own built-in provider registration path)
  // go through our filter.

  const originalRegisterProvider = pi.registerProvider.bind(pi);

  function patchedRegisterProvider(
    providerOrName: string | any,
    configOrUndefined?: any,
  ): void {
    const providerName: string =
      typeof providerOrName === "string" ? providerOrName : providerOrName?.id ?? "unknown";

    // Legacy form: pi.registerProvider("name", { models, refreshModels, ... })
    if (typeof providerOrName === "string" && configOrUndefined !== undefined) {
      const config = { ...configOrUndefined };

      if (Array.isArray(config.models)) {
        config.models = filterModelList(
          config.models as ModelDef[],
          providerName,
          keepSet(),
          cfg.disabled,
        );
      }

      if (typeof config.refreshModels === "function") {
        config.refreshModels = wrapRefreshModels(
          config.refreshModels,
          providerName,
          () => cfg,
        );
      }

      originalRegisterProvider(providerOrName, config);
      return;
    }

    // Native Provider object form – filter is not applied here
    // (documented limitation: native providers bypass the patch).
    originalRegisterProvider(providerOrName as any);
  }

  // Patch the object passed to us
  (pi as any).registerProvider = patchedRegisterProvider;

  // ── /model-filter command ─────────────────────────────────────────

  pi.registerCommand("model-filter", {
    description: "Configure the model version filter (hide superseded versions)",
    handler: async (args: string, ctx: any) => {
      const action = args.trim();
      const notify = (msg: string, type = "info") => ctx.ui.notify?.(msg, type);

      switch (action) {
        case "":
        case "status": {
          const lines = [
            `Filter: ${cfg.disabled ? "DISABLED" : "active"}`,
            `Kept models: ${cfg.keep.length === 0 ? "(none)" : cfg.keep.join(", ")}`,
            "Tip: /reload re-applies the filter to all providers",
          ];
          notify(lines.join("\n"));
          break;
        }
        case "enable": {
          cfg.disabled = false;
          saveConfig(cfg);
          refreshConfig();
          notify("model-filter: enabled. Run /reload to re-apply to all providers.");
          break;
        }
        case "disable": {
          cfg.disabled = true;
          saveConfig(cfg);
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
          saveConfig(cfg);
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
          saveConfig(cfg);
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
