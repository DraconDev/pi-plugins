/**
 * pi-stale-model-filter
 *
 * Hides superseded model versions from pi's /model selector, Ctrl+P model
 * cycling, and --models CLI scoping, without any per-provider wiring.
 *
 * How it works
 * ────────────
 * On every pi session start (or /reload) the extension:
 *
 *   1. Reads the live model registry, including built-in, models.json,
 *      and extension-registered providers.
 *   2. Re-registers every provider with a model-list filter in front of
 *      its existing provider filter.
 *   3. Groups models by provider + base name (everything around the
 *      rightmost numeric version token, e.g. "agnes-2.0-flash" → base
 *      "agnes-flash", version "2.0").
 *   4. Within each group, keeps only the numerically highest version.
 *      Older versions are removed from availability, so they disappear
 *      from /model, Ctrl+P cycling, /scoped-models, and RPC model lists.
 *
 * The wrapper remains attached when pi refreshes provider catalogs, so
 * live discovery cannot reintroduce stale entries.
 *
 * Design boundary
 * ────────────────
 * Version detection is based purely on numeric suffixes. A model ID like
 * "agnes-2.0-flash" is parsed as base "agnes-flash", version "2.0".
 * "agnes-3.0-flash" → base "agnes-flash", version "3.0". So the two group
 * together and only 3.0 survives.
 *
 * Models without a numeric version suffix are singletons and are never
 * filtered — no false positives on e.g. "llama3-8b-instruct".
 *
 * Commands
 * ────────
 *   /stale-model-filter status     – show what's being filtered and why
 *   /stale-model-filter enable     – re-enable filtering
 *   /stale-model-filter disable    – turn it off
 *   /stale-model-filter keep <id>  – protect a model from filtering
 *   /stale-model-filter unkeep <id>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FilterConfig {
  version: 1;
  disabled: boolean;
  /** "provider/model-id" strings that must survive filtering. */
  keep: string[];
}

export const DEFAULT_CONFIG: FilterConfig = { version: 1, disabled: false, keep: [] };

// ─── Pure version logic ───────────────────────────────────────────────────

/**
 * Parse a model id into { base, version }.
 *
 * The version is the rightmost contiguous run of numeric or dotted-numeric
 * hyphen-separated segments. Everything else (qualifiers like "flash",
 * "pro", "coder" that come before or after the version) is part of the base.
 *
 *   "agnes-2.0-flash"     → base "agnes-flash",    version "2.0"
 *   "agnes-3.0-flash"     → base "agnes-flash",    version "3.0"
 *   "gpt-5.5"            → base "gpt",             version "5.5"
 *   "claude-sonnet-4-5"  → base "claude-sonnet",   version "4.5"
 *   "my-model"           → null
 *
 * A "numeric segment" is a plain integer ("4", "5") or a dotted number
 * ("2.0", "4.5"). We find the rightmost contiguous run of numeric
 * segments; that run becomes the version (joined with ".").
 */
export function parseModelVersion(
  id: string,
): { base: string; version: string } | null {
  const parts = id.split("-");
  if (parts.length < 2) return null;

  const isNumSeg = (s: string) =>
    /^\d+$/.test(s) || /^\d+(\.\d+)+$/.test(s);

  // Find the rightmost run of numeric segments.
  let end = parts.length;
  while (end > 0 && !isNumSeg(parts[end - 1])) end--;
  if (end === 0) return null;

  let start = end;
  while (start > 0 && isNumSeg(parts[start - 1])) start--;

  const base = [...parts.slice(0, start), ...parts.slice(end)].join("-");
  if (!base) return null;
  const version = parts.slice(start, end).join(".");
  return { base, version };
}

/** Numeric comparison of two dot-separated version strings. */
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

/**
 * Filter a flat array of model definitions.
 * Returns a new array with superseded versions removed.
 *
 * @param models     – model array (each entry must have an `id` field)
 * @param provider   – provider id (e.g. "agnes", "openai")
 * @param keepSet    – fully-qualified "provider/id" strings to always keep
 * @param disabled   – when true, returns the input array unchanged
 */
export function filterSuperseded<T extends { id: string }>(
  models: T[],
  provider: string,
  keepSet: ReadonlySet<string>,
  disabled: boolean,
): T[] {
  if (disabled) return models;
  if (models.length === 0) return models;

  interface Group {
    key: string;
    winner: T;
    winnerVersion: string | null;
    members: T[];
  }

  const groups = new Map<string, Group>();

  for (const m of models) {
    const pv = parseModelVersion(m.id);
    // Use the provider-qualified key so same-named models from different
    // providers never compete.
    const groupKey = pv
      ? `${provider}:${pv.base}`
      : `${provider}:${m.id}::__singleton__`;

    let g = groups.get(groupKey);
    if (!g) {
      g = { key: groupKey, winner: m, winnerVersion: pv?.version ?? null, members: [] };
      groups.set(groupKey, g);
    }
    g.members.push(m);

    if (pv) {
      const cmp = g.winnerVersion === null ? 1 : compareVersions(pv.version, g.winnerVersion);
      if (cmp > 0) {
        g.winner = m;
        g.winnerVersion = pv.version;
      }
    }
  }

  const result: T[] = [];
  const included = new Set<T>();

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

// ─── Config I/O ─────────────────────────────────────────────────────────────

export function configPathFor(agentDir: string): string {
  return join(agentDir, "stale-model-filter.json");
}

export function loadConfig(agentDir: string): FilterConfig {
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

export function saveConfig(agentDir: string, cfg: FilterConfig): void {
  try {
    const p = configPathFor(agentDir);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2));
  } catch {
    // non-fatal
  }
}

// ─── Provider wrapping helpers ─────────────────────────────────────────────

/**
 * Wrap a Provider object so that getModels() returns a filtered list.
 */
export function wrapProviderGetModels<T extends { id: string }>(
  provider: { getModels: () => T[] },
  providerId: string,
  agentDir: string,
): () => T[] {
  const original = provider.getModels.bind(provider);
  return () => {
    const cfg = loadConfig(agentDir);
    return filterSuperseded(original(), providerId, new Set(cfg.keep), cfg.disabled);
  };
}

/**
 * Wrap a refreshModels callback so its returned list is filtered on
 * each call (re-reads config live).
 */
export function wrapRefreshModels<T extends { id: string }>(
  original:
    | ((ctx: unknown) => Promise<T[] | undefined | null>)
    | undefined,
  providerId: string,
  agentDir: string,
): typeof original {
  if (!original) return original;
  return (async (ctx: unknown) => {
    const result = await original(ctx);
    if (!result) return result;
    const cfg = loadConfig(agentDir);
    return filterSuperseded(result, providerId, new Set(cfg.keep), cfg.disabled);
  }) as typeof original;
}

/**
 * Filter a static model list using the live config on disk.
 */
export function filterModelsForProvider<T extends { id: string }>(
  models: T[],
  providerId: string,
  agentDir: string,
): T[] {
  const cfg = loadConfig(agentDir);
  return filterSuperseded(models, providerId, new Set(cfg.keep), cfg.disabled);
}

// ─── Runtime provider wrapping ─────────────────────────────────────────────

/**
 * Return a provider whose existing `filterModels` hook is composed with
 * this extension's stale-version filter.
 *
 * Registering the returned provider through pi.registerProvider(provider)
 * makes the filter part of the normal provider availability pipeline.
 * Pi's createModels()/ModelRuntime applies provider.filterModels whenever
 * it builds the available-model snapshot used by every model picker.
 */
export function withStaleModelFilter<TModel extends { id: string }>(
  provider: {
    id: string;
    filterModels?: (
      models: readonly TModel[],
      credential: unknown,
    ) => readonly TModel[];
  } & Record<string, unknown>,
  agentDir: string,
): typeof provider {
  const originalFilter = provider.filterModels?.bind(provider);

  return {
    ...provider,
    filterModels(models: readonly TModel[], credential: unknown): readonly TModel[] {
      // Preserve provider-specific availability rules (for example
      // GitHub Copilot's OAuth model allowlist) before version filtering.
      const providerVisible = originalFilter
        ? originalFilter(models, credential)
        : models;
      const cfg = loadConfig(agentDir);
      return filterSuperseded(
        [...providerVisible],
        provider.id,
        new Set(cfg.keep),
        cfg.disabled,
      );
    },
  };
}

// ─── Extension entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  let cfg: FilterConfig = loadConfig(agentDir);

  function refresh() {
    cfg = loadConfig(agentDir);
  }

  // Install the filter on the live provider objects. This is deliberately
  // done through the public extension API rather than by rewriting
  // models-store.json: the latter would lose provider auth, streaming,
  // refresh, and model metadata, and would not affect the in-memory
  // availability snapshot used by /model.
  pi.on("session_start", async (_event, ctx) => {
    refresh();

    const providerIds = new Set<string>();
    for (const model of ctx.modelRegistry.getAll()) {
      providerIds.add(model.provider);
    }
    for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
      providerIds.add(providerId);
    }

    for (const providerId of providerIds) {
      const provider = ctx.modelRegistry.getProvider(providerId);
      if (!provider) continue;
      pi.registerProvider(
        withStaleModelFilter(provider as any, agentDir) as any,
      );
    }

    // Recompute the available-model snapshot after all provider wrappers
    // are registered. This is offline: it preserves the current catalog
    // while making the filtered result immediately visible to /model.
    await ctx.modelRegistry.refresh({ allowNetwork: false });
  });

  pi.registerCommand("stale-model-filter", {
    description:
      "Configure stale-model filtering (hide superseded version suffixes from /model)",
    handler: async (args: string, ctx: any) => {
      const action = args.trim();
      const notify = (msg: string, type = "info") => ctx.ui.notify?.(msg, type);

      switch (action) {
        case "":
        case "status": {
          const lines = [
            `Stale-model filter: ${cfg.disabled ? "DISABLED" : "active"}`,
            cfg.keep.length === 0
              ? "No models explicitly kept."
              : `Kept: ${cfg.keep.join(", ")}`,
            "Takes effect on next /reload or new session.",
          ];
          notify(lines.join("\n"));
          break;
        }
        case "enable": {
          cfg.disabled = false;
          saveConfig(agentDir, cfg);
          refresh();
          notify("stale-model-filter: enabled. Takes effect on next /reload or new session.");
          break;
        }
        case "disable": {
          cfg.disabled = true;
          saveConfig(agentDir, cfg);
          refresh();
          notify("stale-model-filter: disabled. Takes effect on next /reload or new session.");
          break;
        }
        case "keep": {
          const id = action.slice(5).trim();
          if (!id) {
            notify("Usage: /stale-model-filter keep <provider/model-id>", "warn");
            break;
          }
          if (!cfg.keep.includes(id)) cfg.keep.push(id);
          saveConfig(agentDir, cfg);
          refresh();
          notify(`stale-model-filter: keeping ${id}`);
          break;
        }
        case "unkeep": {
          const id = action.slice(7).trim();
          if (!id) {
            notify("Usage: /stale-model-filter unkeep <provider/model-id>", "warn");
            break;
          }
          cfg.keep = cfg.keep.filter((k) => k !== id);
          saveConfig(agentDir, cfg);
          refresh();
          notify(`stale-model-filter: released ${id}`);
          break;
        }
        default:
          notify(
            [
              "Usage:",
              "  /stale-model-filter status",
              "  /stale-model-filter enable | disable",
              "  /stale-model-filter keep <provider/model-id>",
              "  /stale-model-filter unkeep <provider/model-id>",
            ].join("\n"),
            "warn",
          );
      }
    },
  });
}
