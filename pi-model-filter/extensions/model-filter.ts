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
 * Integration
 *   Provider-owning extensions (like pi-agnes-tools) import the pure
 *   core from ./model-filter-core (no pi dependency) and call:
 *
 *     import { filterModelList, loadConfigFor, getAgentDir,
 *              wrapRefreshModels } from "pi-model-filter/extensions/...";
 *
 *   This file (model-filter.ts) is the pi extension entry point: it
 *   registers the /model-filter command, owns the on-disk config, and
 *   exports the convenience helpers used by other extensions.
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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

// Re-export the pure core so consumers can import from either file.
export {
  splitVersion,
  compareVersions,
  filterModelList,
  DEFAULT_CONFIG,
} from "./model-filter-core.js";
export type { FilterConfig, ModelDef, RefreshModelsFn } from "./model-filter-core.js";

import {
  DEFAULT_CONFIG,
  filterModelList,
  type FilterConfig,
  type ModelDef,
  type RefreshModelsFn,
} from "./model-filter-core.js";

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

// ─── Integration helpers (for provider-owning extensions) ─────────────────

/**
 * Wrap an existing `refreshModels` callback so its returned model list
 * is filtered through the live config on disk each time it runs.
 * Returns the original when `original` is undefined.
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

// ─── Extension entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let cfg: FilterConfig = loadConfigFor(getAgentDir());

  function refreshConfig() {
    cfg = loadConfigFor(getAgentDir());
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
            "Refresh callbacks read the config live; static lists re-apply on /reload or a new session.",
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
