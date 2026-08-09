/**
 * Slash-command implementations for the auto-fallback-router.
 *
 * Every /fallback subcommand is implemented here. They share:
 *   • access to loadConfig/saveConfig for persistent chain + triggers
 *   • the custom UI components from ./ui.ts (chain editor, condition editor,
 *     model picker)
 *   • the helper formatters in ./helpers.ts (statusLine, dumpChain)
 *
 * Subcommands covered:
 *   (none)        → open chain editor
 *   help          → show command reference
 *   add           → fuzzy-pick a model and append
 *   pick          → fuzzy-pick a model and insert at a chosen position
 *   remove <idx>  → remove by index (or via picker if no index given)
 *   move <i> <j>  → reorder
 *   list          → text dump
 *   status        → one-line status
 *   condition     → open trigger editor
 *   enable|disable → toggle the router
 *   reset         → clear runtime counters, sick marks, fallbacks-used
 *   clear         → empty the chain
 *   skip          → toggle sick mark on the current model
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { CONFIG_PATH, loadConfig, saveConfig } from "./config.js";
import { chainEntryKey, isSick, modelKey } from "./health.js";
import { openChainEditor, openConditionEditor, openModelPicker } from "./ui.js";

// ─── Formatters (text-mode-friendly) ────────────────────────────────────────

export function statusLine(ctx: ExtensionCommandContext, cfg: Config): string {
  const cur = ctx.model ? modelKey(ctx.model) : "(none)";
  const lastFail = ctx.model ? isSick(modelKey(ctx.model)) : false;
  const sickTag = lastFail ? " sick" : "";
  return `${cur}  enabled=${cfg.enabled}  chain=${cfg.chain.length}  ${sickTag}`;
}

export function dumpChain(cfg: Config): string {
  const lines: string[] = [];
  lines.push(`enabled: ${cfg.enabled}`);
  lines.push(`triggers:`);
  for (const [k, v] of Object.entries(cfg.triggers)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push(`chain (${cfg.chain.length}):`);
  if (cfg.chain.length === 0) {
    lines.push("  (empty)");
  } else {
    cfg.chain.forEach((e, i) => {
      const sick = isSick(chainEntryKey(e)) ? "  [sick]" : "";
      lines.push(`  ${(i + 1).toString().padStart(2)}. ${e.provider}/${e.id}${e.name ? `  (${e.name})` : ""}${sick}`);
    });
  }
  return lines.join("\n");
}

// ─── Command registration ────────────────────────────────────────────────────

interface RuntimeState {
  currentIndex: number;
  recentFallbacks: number;
  sickKeys(): IterableIterator<string>;
  clearAll(): void;
}

export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
  pi.registerCommand("fallback", {
    description: "Auto fallback router — chain of fallback models with time/error triggers. Subcommands: add, pick, remove, move, list, status, condition, enable, disable, reset, clear, skip, help",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["add", "pick", "remove", "move", "list", "status", "condition", "enable", "disable", "reset", "clear", "skip", "help"];
      return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      const cfg = loadConfig();
      const arg = (args ?? "").trim();
      const sub = arg.split(/\s+/)[0] ?? "";

      if (sub === "" || sub === "edit" || sub === "open") {
        const result = await openChainEditor(ctx, cfg.chain, state.currentIndex);
        if (result.action === "commit") {
          saveConfig({ ...cfg, chain: result.chain });
          ctx.ui.notify(`Chain saved (${result.chain.length} models)`, "info");
        } else if (result.action === "cancel") {
          ctx.ui.notify("Cancelled", "info");
        }
        return;
      }

      if (sub === "help") {
        ctx.ui.notify(
          [
            "/fallback                open chain editor (add/remove/reorder)",
            "/fallback add            fuzzy-pick and append a model",
            "/fallback pick           fuzzy-pick and insert at position",
            "/fallback remove [idx]   remove a chain entry",
            "/fallback move <i> <j>   move entry at i to position j",
            "/fallback list           dump chain + triggers",
            "/fallback status         one-line status",
            "/fallback condition      edit triggers",
            "/fallback enable | disable",
            "/fallback reset          clear counters, sick marks, fallbacks-used",
            "/fallback clear          empty the chain",
            "/fallback skip           toggle sick on the current model",
            "",
            `Config: ${CONFIG_PATH}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "add") {
        const entry = await openModelPicker(ctx, "Pick a model to ADD to fallback chain");
        if (!entry) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
        if (cfg.chain.some((e) => chainEntryKey(e) === chainEntryKey(entry))) {
          ctx.ui.notify(`${chainEntryKey(entry)} already in chain`, "warning");
          return;
        }
        const newChain = [...cfg.chain, entry];
        saveConfig({ ...cfg, chain: newChain });
        ctx.ui.notify(`Added ${chainEntryKey(entry)} at end (chain size: ${newChain.length})`, "info");
        return;
      }

      if (sub === "pick") {
        const entry = await openModelPicker(ctx, "Pick a model to INSERT into fallback chain");
        if (!entry) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
        let pos = cfg.chain.length; // default: append
        if (cfg.chain.length > 0) {
          const labels = [
            "Append (at end)",
            ...cfg.chain.map((e, i) => `Insert BEFORE ${i + 1}. ${e.provider}/${e.id}`),
            `Insert AFTER ${cfg.chain.length}. ${cfg.chain[cfg.chain.length - 1].provider}/${cfg.chain[cfg.chain.length - 1].id}`,
          ];
          const pick = await ctx.ui.select(`Insert ${chainEntryKey(entry)} where?`, labels);
          if (!pick) {
            ctx.ui.notify("Cancelled", "info");
            return;
          }
          if (pick.startsWith("Append")) pos = cfg.chain.length;
          else if (pick.startsWith("Insert BEFORE")) pos = parseInt(pick.split(" ")[2], 10) - 1;
          else if (pick.startsWith("Insert AFTER")) pos = parseInt(pick.split(" ")[2], 10);
        }
        const newChain = [...cfg.chain.slice(0, pos), entry, ...cfg.chain.slice(pos)];
        saveConfig({ ...cfg, chain: newChain });
        ctx.ui.notify(`Inserted ${chainEntryKey(entry)} at position ${pos + 1}`, "info");
        return;
      }

      if (sub === "remove") {
        const idxStr = arg.split(/\s+/)[1];
        if (!idxStr) {
          if (cfg.chain.length === 0) {
            ctx.ui.notify("Chain is empty", "info");
            return;
          }
          const labels = cfg.chain.map((e, i) => `${i + 1}. ${e.provider}/${e.id}`);
          const pick = await ctx.ui.select("Remove which?", labels);
          if (!pick) {
            ctx.ui.notify("Cancelled", "info");
            return;
          }
          const idx = parseInt(pick.split(".")[0], 10) - 1;
          const removed = cfg.chain[idx];
          const newChain = cfg.chain.filter((_, i) => i !== idx);
          saveConfig({ ...cfg, chain: newChain });
          ctx.ui.notify(`Removed ${chainEntryKey(removed)}`, "info");
          return;
        }
        const idx = parseInt(idxStr, 10) - 1;
        if (!Number.isFinite(idx) || idx < 0 || idx >= cfg.chain.length) {
          ctx.ui.notify(`Invalid index: ${idxStr}`, "error");
          return;
        }
        const removed = cfg.chain[idx];
        const newChain = cfg.chain.filter((_, i) => i !== idx);
        saveConfig({ ...cfg, chain: newChain });
        ctx.ui.notify(`Removed ${chainEntryKey(removed)}`, "info");
        return;
      }

      if (sub === "move") {
        const parts = arg.split(/\s+/);
        if (parts.length < 3) {
          ctx.ui.notify("Usage: /fallback move <from-index> <to-index>", "error");
          return;
        }
        const from = parseInt(parts[1], 10) - 1;
        const to = parseInt(parts[2], 10) - 1;
        if (!Number.isFinite(from) || !Number.isFinite(to) ||
            from < 0 || from >= cfg.chain.length ||
            to < 0 || to >= cfg.chain.length) {
          ctx.ui.notify("Invalid index", "error");
          return;
        }
        const newChain = [...cfg.chain];
        const [item] = newChain.splice(from, 1);
        newChain.splice(to, 0, item);
        saveConfig({ ...cfg, chain: newChain });
        ctx.ui.notify(`Moved ${chainEntryKey(item)} from ${from + 1} to ${to + 1}`, "info");
        return;
      }

      if (sub === "list") {
        ctx.ui.notify(dumpChain(loadConfig()), "info");
        return;
      }

      if (sub === "status") {
        ctx.ui.notify(statusLine(ctx, loadConfig()), "info");
        return;
      }

      if (sub === "condition") {
        const result = await openConditionEditor(ctx, cfg.triggers);
        saveConfig({ ...loadConfig(), triggers: result.triggers });
        ctx.ui.notify(
          `Triggers saved (timeoutMs=${result.triggers.timeoutMs}, consecutiveErrors=${result.triggers.consecutiveErrors}, errorsInWindow=${result.triggers.errorsInWindow}, windowMs=${result.triggers.windowMs})`,
          "info",
        );
        return;
      }

      if (sub === "enable") {
        saveConfig({ ...cfg, enabled: true });
        ctx.ui.notify("Fallback router ENABLED", "info");
        return;
      }

      if (sub === "disable") {
        saveConfig({ ...cfg, enabled: false });
        ctx.ui.notify("Fallback router DISABLED", "info");
        return;
      }

      if (sub === "reset") {
        state.clearAll();
        ctx.ui.notify("Counters, sick marks, and fallbacks-used cleared", "info");
        return;
      }

      if (sub === "clear") {
        saveConfig({ ...cfg, chain: [] });
        ctx.ui.notify("Chain cleared", "info");
        return;
      }

      if (sub === "skip") {
        if (!ctx.model) {
          ctx.ui.notify("No active model", "error");
          return;
        }
        const k = modelKey(ctx.model);
        // Use the loaded health via isSick to read; toggle by writing the
        // timestamp via state.clearAll is too coarse — instead we need direct
        // health access. Expose via state object: actually we'll keep this
        // simple and call isSick to read, then toggle via the underlying map.
        // The state.clearAll path clears everything; for a single toggle we
        // import the map directly.
        const { getHealth } = await import("./health.js");
        const h = getHealth(k);
        const now = Date.now();
        if (h.sickUntil === 0 || now >= h.sickUntil) {
          h.sickUntil = now + (cfg.triggers.skipFailingForMs || 300_000);
          ctx.ui.notify(`Marked ${k} sick until ${new Date(h.sickUntil).toLocaleTimeString()}`, "warning");
        } else {
          h.sickUntil = 0;
          ctx.ui.notify(`Cleared sick mark on ${k}`, "info");
        }
        return;
      }

      ctx.ui.notify(`Unknown subcommand: ${sub}. Try /fallback help`, "error");
    },
  });
}