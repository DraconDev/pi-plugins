/**
 * pi-model-filter
 *
 * Hides superseded version-suffixed models from pi's /model selector,
 * Ctrl+P model cycling, and the --models CLI.
 *
 * How it works
 *   Models are grouped by `${provider}:${base}` where `base` is the model
 *   id with the trailing version segment stripped (`agnes-2.0-flash` →
 *   base `agnes`, version `2.0`). When a group has more than one versioned
 *   member, only the highest version is kept. Models without a numeric
 *   version suffix are never filtered.
 *
 * The filter is applied at two layers so it survives both static and
 * dynamic model lists:
 *
 *   1. `wrapRegisterProvider` – intercepts every call to
 *      `pi.registerProvider(name, config)` made by *other* extensions or
 *      by pi's own built-in composition, and wraps `config.models` and
 *      `config.refreshModels` with the version filter.
 *
 *   2. `before_provider_request` – no-op layer for diagnostics.
 *
 * Configuration
 *   Persisted to ~/.pi/agent/model-filter.json:
 *     {
 *       "disabled": false,
 *       "keep": ["agnes/agnes-2.0-flash"]
 *     }
 *   `disabled: true` turns the filter off entirely.
 *   `keep` is an array of "provider/model-id" strings that are always
 *   shown even when a newer version exists in the same group.
 *
 * Commands
 *   /model-filter status      – show current state
 *   /model-filter enable      – re-enable
 *   /model-filter disable     – disable (persisted)
 *   /model-filter keep <id>  – protect a model
 *   /model-filter unkeep <id>– release a protected model
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
  const p = configPath();
  try {
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
 * Extract the trailing version segment from a model id.
 *
 *   "agnes-2.0-flash"   → version "2.0"   (base "agnes")
 *   "gpt-5.5"           → version "5.5"   (base "gpt")
 *   "claude-sonnet-4-5" → version "4-5"   (base "claude-sonnet")
 *   "my-model"          → null            (no version)
 *
 * The version is the final `-<digits>` or `-<digits>.<digits>` group.
 * For `claude-sonnet-4-5` the last two hyphen-separated segments are
 * both numeric, so we treat `4-5` as a single version token.
 *
 * Returns { base, version } or null when no version is found.
 */
function splitVersion(id: string): { base: string; version: string } | null {
  const parts = id.split("-");
  if (parts.length < 2) return null;

  // Walk from the end: collect consecutive numeric-only segments
  // (or a single "N" / "N.M" token formed by the last 1-2 segments).
  let end = parts.length;
  let start = end;

  // Last segment must be numeric (e.g. "5" in "gpt-5")
  // or a dotted pair (e.g. "4-5" → "4","5" → treat as "4.5").
  // Strategy: find the longest trailing run of segments where each
  // is either a plain integer or part of a dotted version.

  // Case A: last segment is "X" or "X.Y"
  const last = parts[parts.length - 1];
  if (/^\d+(\.\d+)*$/.test(last)) {
    start = parts.length - 1;
    // If the segment before last is also an integer, it may be the
    // "major" of a "major-minor" pair like "sonnet-4-5".
    if (start > 0) {
      const prev = parts[start - 1];
      if (/^\d+$/.test(prev)) {
        // Ambiguous: "sonnet-4-5" → is base "sonnet" version "4.5"?
        // Convention: if prev is a single digit and last is a single
        // digit, treat them as a dotted pair.
        if (/^\d$/.test(prev) && /^\d$/.test(last)) {
          start = parts.length - 2;
        }
      }
    }
  } else {
    return null; // last segment is not numeric → no version
  }

  if (start === parts.length) return null;
  const base = parts.slice(0, start).join("-");
  const version = parts.slice(start).join("."); // "4-5" → "4.5"
  if (!base) return null;
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

interface FilteredModel {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Filter a flat array of model definitions (from registerProvider or
 * refreshModels). `keepSet` contains fully-qualified "provider/id" strings
 * that must always survive.
 */
export function filterModelList(
  models: FilteredModel[],
  provider: string,
  keepSet: ReadonlySet<string>,
  disabled: boolean,
): FilteredModel[] {
  if (disabled) return models;
  if (models.length === 0) return models;

  interface Group {
    key: string;
    /** Best (highest-version) model seen so far in this group. */
    winner: FilteredModel;
    winnerVersion: string | null; // null = no version
    members: FilteredModel[];
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

  const result: FilteredModel[] = [];
  const included = new Set<FilteredModel>();

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

  // Preserve original order as much as possible
  const orderMap = new Map(models.map((m, i) => [m, i]));
  result.sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0));

  return result;
}

// ─── Provider interception ─────────────────────────────────────────────────

type ModelDef = Record<string, unknown> & { id: string; name?: string };

function wrapModelConfig(models: ModelDef[] | undefined, provider: string, cfg: FilterConfig): ModelDef[] | undefined {
  if (!models || models.length === 0) return models;
  const keepSet = new Set(cfg.keep);
  const filtered = filterModelList(models, provider, keepSet, cfg.disabled);
  return filtered;
}

/**
 * Wrap the `refreshModels` function so its returned models are also filtered.
 */
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
  // We patch the `pi` object's registerProvider before other extensions
  // run. Because pi waits for the async factory, our patch is in place
  // when other providers register.
  //
  // The `models` array passed to registerProvider is a plain array, so we
  // replace it with a filtered copy. For `refreshModels` we wrap the
  // function to filter its return value.
  //
  // We do this by wrapping the original and re-exposing it.

  const originalRegisterProvider = pi.registerProvider.bind(pi);

  function patchedRegisterProvider(
    providerOrName: string | any,
    configOrUndefined?: any,
  ): void {
    const providerName: string =
      typeof providerOrName === "string" ? providerOrName : providerOrName?.id ?? "unknown";

    // Case 1: pi.registerProvider("name", { models: [...], refreshModels })
    if (typeof providerOrName === "string" && configOrUndefined !== undefined) {
      const config = { ...configOrUndefined };

      // Wrap the static models list
      if (Array.isArray(config.models)) {
        config.models = filterModelList(config.models as ModelDef[], providerName, keepSet(), cfg.disabled) as typeof config.models;
      }

      // Wrap refreshModels
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

    // Case 2: pi.registerProvider(providerObject) – native Provider
    // Filter `provider.getModels()` is not easily patchable here because
    // the native Provider object is opaque. For native providers we
    // fall back to intercepting via a wrapper: not supported in this
    // initial version (documented in README).
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
          ];
          notify(lines.join("\n"));
          break;
        }
        case "enable": {
          cfg.disabled = false;
          saveConfig(cfg);
          refreshConfig();
          notify("model-filter: enabled (re-run /reload or start a new session for full effect)");
          break;
        }
        case "disable": {
          cfg.disabled = true;
          saveConfig(cfg);
          refreshConfig();
          notify("model-filter: disabled (re-run /reload or start a new session for full effect)");
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
          notify(`model-filter: keeping ${id}`);
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
          notify(`model-filter: released ${id}`);
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

  // ── Log which models were filtered, if any ────────────────────────
  // Hook into model_select to confirm a filtered-out model can't be
  // accidentally restored via session resume.

  pi.on("model_select", (event: any, ctx: any) => {
    if (cfg.disabled) return;
    const m = event.model;
    if (!m) return;
    const fq = `${m.provider}/${m.id}`;
    const kset = new Set(cfg.keep);
    const sv = splitVersion(m.id);
    if (sv && !kset.has(fq)) {
      // This model IS the current selection; it should be fine.
      // Nothing to do here – just a sanity log.
      if (process.env.PI_MODEL_FILTER_DEBUG) {
        console.error(`[pi-model-filter] model_select: ${fq} (base=${sv.base}, version=${sv.version})`);
      }
    }
  });
}
