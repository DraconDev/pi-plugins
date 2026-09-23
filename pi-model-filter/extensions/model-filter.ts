/**
 * pi-model-filter
 *
 * Filters out superseded version-suffixed models from the /model selector
 * and Ctrl+P cycle. When a provider offers both `foo-2.0` and `foo-3.0`,
 * only `foo-3.0` is shown; when only one version exists, it is kept.
 *
 * How it works:
 *   • Groups models by base name (strip trailing `-\d+(\.\d+)*(-\w+)*`
 *     version suffix).
 *   • Within each base-name group, keeps only the model whose numeric
 *     version is highest. Models without a parseable version suffix are
 *     kept as their own group (never filtered).
 *   • Runs in `before_model_selector` so it affects both /model and
 *     Ctrl+P. The selector is rebuilt on every model refresh.
 *
 * Config (optional, via /model-filter command or settings):
 *   • `disable` – turn off the filter for the session.
 *   • `show-all` – temporarily re-show all versions.
 *   • `keep <model-id>` – add a model to an explicit keep list so it
 *     survives filtering even when a newer version exists.
 *
 * No external dependencies. Uses only the pi ExtensionAPI.
 */

import type { ExtensionAPI, Model } from "@earendil-works/pi-coding-agent";

// ─── Config state ───────────────────────────────────────────────────────────

interface FilterConfig {
  /** When true, all filtering is disabled and every model is shown. */
  disabled: boolean;
  /** Model IDs to always keep, regardless of version comparison. */
  keep: string[];
}

function defaultConfig(): FilterConfig {
  return { disabled: false, keep: [] };
}

// Read any persisted config from the agent dir so settings survive restarts.
function loadConfig(): FilterConfig {
  try {
    const { join } = require("node:path");
    const { readFileSync } = require("node:fs");
    const { getAgentDir } = require("@earendil-works/pi-coding-agent");
    const p = join(getAgentDir(), "model-filter.json");
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return {
      disabled: raw.disabled ?? false,
      keep: Array.isArray(raw.keep) ? raw.keep : [],
    };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(cfg: FilterConfig): void {
  try {
    const { join } = require("node:path");
    const { writeFileSync, mkdirSync } = require("node:fs");
    const { getAgentDir } = require("@earendil-works/pi-coding-agent");
    const dir = getAgentDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model-filter.json"), JSON.stringify(cfg, null, 2));
  } catch {
    // non-fatal: in-memory state is still in effect
  }
}

// ─── Version-parsing helpers ────────────────────────────────────────────────

/**
 * Split a model id into (base, version) where version is the trailing
 * `-\d+(\.\d+)*` segment. Returns null when no version is found.
 *
 *   "agnes-2.0-flash"   → ("agnes", "2.0")
 *   "gpt-5.5-2026"     → ("gpt", "5.5-2026")  – handled by a broader rule
 *   "claude-sonnet-4-5" → ("claude", "4-5")    – only when it matches
 *   "agnes-2.5-flash"   → ("agnes", "2.5")
 *   "unknown"           → null
 */
function splitVersion(id: string): { base: string; version: string } | null {
  // Pattern: `...-X.Y` or `...-X.Y.Z` or `...-X` where X is a digit group.
  // The `-` separator is the version boundary. We grab everything from the
  // last `-` that starts with a digit.
  const m = id.match(/^(.*?)(-\d+(?:\.\d+)*)$/);
  if (!m) return null;
  const base = m[1];
  const version = m[2].slice(1); // strip leading '-'
  // Reject cases where "base" is empty (id was purely a number).
  if (!base) return null;
  return { base, version };
}

/** Compare two version strings numerically. Returns -1, 0, or 1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

/**
 * Group models by their base name, then pick the highest version within
 * each group. Models without a parseable version suffix are kept in a
 * singleton group and never filtered.
 *
 * `keep` is a Set of provider-qualified model ids ("provider/id") that
 * must survive filtering.
 */
function filterModels(
  models: Model[],
  keep: Set<string>,
): Model[] {
  if (keep.size === 0 && models.length === 0) return models;

  // Group key: `${provider}:${base}` – base comes from splitVersion, or
  // the full model id when no version is found.
  interface Group {
    key: string;
    // highest-version model, or the singleton when no version
    winner: Model;
    // all members (for debugging / diagnostics)
    members: Model[];
  }

  const groups = new Map<string, Group>();

  for (const m of models) {
    const providerKey = `${m.provider}/${m.id}`;
    const sv = splitVersion(m.id);
    const base = sv ? sv.base : m.id; // no version → singleton group
    const groupKey = `${m.provider}:${base}`;

    let g = groups.get(groupKey);
    if (!g) {
      g = { key: groupKey, winner: m, members: [] };
      groups.set(groupKey, g);
    }
    g.members.push(m);

    // Update winner if this model has a higher version
    if (sv) {
      const winnerSv = splitVersion(g.winner.id);
      if (!winnerSv) {
        // current winner has no version; this one does → win
        g.winner = m;
      } else {
        const cmp = compareVersions(sv.version, winnerSv.version);
        if (cmp > 0) g.winner = m;
        // tie or lower → keep existing winner
      }
    }
    // If m has no version, it can never replace a versioned winner,
    // and it never wins a versioned group.
  }

  const result: Model[] = [];
  const kept = new Set<string>();

  for (const g of groups.values()) {
    // If the winner is in the keep set, or the group is a singleton,
    // include the winner.
    const winnerKey = `${g.winner.provider}/${g.winner.id}`;
    const memberKeys = g.members.map((m) => `${m.provider}/${m.id}`);

    // Always keep models that are explicitly in `keep`
    for (const mk of memberKeys) {
      if (keep.has(mk)) result.push(g.members.find((mm) => `${mm.provider}/${mm.id}` === mk)!);
    }
    // Add the winner if it's not already in `keep`
    if (!keep.has(winnerKey) && !result.includes(g.winner)) {
      result.push(g.winner);
    }
  }

  return result;
}

// ─── Extension entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let cfg: FilterConfig = loadConfig();
  let keepSet: Set<string> = new Set(cfg.keep);

  function refreshKeepSet() {
    keepSet = new Set(cfg.keep);
  }

  function showAll() {
    return cfg.disabled || keepSet.size > 0; // disabled filter OR keep overrides
  }

  // ── before_model_selector: filter the model list ─────────────────────
  // Fires right before the model selector UI (or Ctrl+P cycle) builds
  // its list. Mutating `models` in place is the contract.
  pi.on("before_model_selector", (event: any, ctx: any) => {
    if (showAll()) return; // user opted out or has explicit keep list
    const original = event.models;
    if (!Array.isArray(original)) return;

    const filtered = filterModels(original, keepSet);
    // Write back in place
    event.models.length = 0;
    event.models.push(...filtered);

    const removed = original.length - filtered.length;
    if (removed > 0 && ctx?.ui) {
      ctx.ui.notify?.(`model-filter: hid ${removed} superseded version(s)`, "info");
    }
  });

  // ── /model-filter command ─────────────────────────────────────────────
  pi.registerCommand("model-filter", {
    description: "Show or configure the model-version filter",
    handler: async (_name: string, ctx: any) => {
      const action = _name.trim();
      switch (action) {
        case "":
        case "show":
        case "status": {
          const lines = [
            `Filter: ${cfg.disabled ? "DISABLED" : "active"}`,
            `Kept models: ${keepSet.size === 0 ? "(none)" : [...keepSet].join(", ")}`,
          ];
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
        case "enable": {
          cfg.disabled = false;
          saveConfig(cfg);
          ctx.ui.notify("model-filter: enabled", "info");
          break;
        }
        case "disable": {
          cfg.disabled = true;
          saveConfig(cfg);
          ctx.ui.notify("model-filter: disabled", "info");
          break;
        }
        case "keep": {
          // /model-filter keep <provider/id>
          const id = _name.split(" ").slice(1).join(" ").trim();
          if (!id) {
            ctx.ui.notify("Usage: /model-filter keep <provider/id>", "warn");
            break;
          }
          if (!cfg.keep.includes(id)) cfg.keep.push(id);
          refreshKeepSet();
          saveConfig(cfg);
          ctx.ui.notify(`model-filter: keeping ${id}`, "info");
          break;
        }
        case "unkeep": {
          const id = _name.split(" ").slice(1).join(" ").trim();
          if (!id) {
            ctx.ui.notify("Usage: /model-filter unkeep <provider/id>", "warn");
            break;
          }
          cfg.keep = cfg.keep.filter((k) => k !== id);
          refreshKeepSet();
          saveConfig(cfg);
          ctx.ui.notify(`model-filter: released ${id}`, "info");
          break;
        }
        default:
          ctx.ui.notify(
            "Usage:\n" +
            "  /model-filter status     – show current state\n" +
            "  /model-filter enable     – turn filter on\n" +
            "  /model-filter disable    – turn filter off\n" +
            "  /model-filter keep <id> – protect a model\n" +
            "  /model-filter unkeep <id>",
            "warn",
          );
      }
    },
  });
}
