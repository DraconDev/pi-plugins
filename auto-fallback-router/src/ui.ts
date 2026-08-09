/**
 * Custom UI components for the fallback router.
 *
 * Three components live here, all built on `ctx.ui.custom()` from
 * `@earendil-works/pi-coding-agent` and primitives from `@earendil-works/pi-tui`:
 *
 *   • openChainEditor      — /model-like list with add/remove/reorder for the
 *                            chain. Tabbed sub-mode for fuzzy-search adds.
 *   • openConditionEditor  — key/value editor for the triggers block.
 *   • openModelPicker      — single-model fuzzy picker (used by /fallback add
 *                            and /fallback pick).
 *
 * Each component has a "simple" variant that delegates to ctx.ui.select for
 * RPC / print modes where the TUI custom overlay is not available.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  Container,
  fuzzyFilter,
  Input,
  matchesKey,
  Text,
  Key,
} from "@earendil-works/pi-tui";

import type { ChainEntry, Triggers } from "./config.js";
import { chainEntryKey, isSick } from "./health.js";

// ─── Chain editor ───────────────────────────────────────────────────────────

export interface ChainEditorResult {
  action: "cancel" | "commit" | "noop";
  chain: ChainEntry[];
}

export async function openChainEditor(
  ctx: ExtensionContext,
  initialChain: ChainEntry[],
  currentIndexInChain: number,
): Promise<ChainEditorResult> {
  if (ctx.mode !== "tui") {
    return openChainEditorSimple(ctx, initialChain);
  }
  const result = await ctx.ui.custom<ChainEditorResult>((tui, theme, _kb, done) => {
    let working: ChainEntry[] = [...initialChain];
    let mode: "list" | "add" | "edit-name" = "list";
    let selectedIndex = Math.max(0, working.length - 1);
    let nameEditIndex = -1;
    let statusLine = "";

    const input = new Input();
    input.onSubmit = () => {
      if (mode === "add") {
        addSelectedFromSearch();
      }
    };

    const listContainer = new Container();

    function refresh() {
      listContainer.clear();
      renderAll();
      tui.requestRender();
    }

    function done_(action: ChainEditorResult["action"]) {
      done({ action, chain: [...working] });
    }

    function addSelectedFromSearch() {
      const q = input.getValue().trim();
      if (!q) {
        statusLine = "Type a fuzzy search first";
        mode = "list";
        input.setValue("");
        refresh();
        return;
      }
      const allModels = ctx.modelRegistry.getAvailable();
      if (allModels.length === 0) {
        statusLine = "No models available in registry";
        mode = "list";
        input.setValue("");
        refresh();
        return;
      }
      const matched = fuzzyFilter(
        allModels.map((m) => ({ m })),
        q,
        ({ m }) => `${m.provider}/${m.id} ${m.name ?? ""}`,
      );
      if (matched.length === 0) {
        statusLine = `No match for "${q}"`;
        mode = "list";
        input.setValue("");
        refresh();
        return;
      }
      const pick = matched[0];
      const newEntry: ChainEntry = { provider: pick.m.provider, id: pick.m.id, name: pick.m.name };
      if (working.some((e) => chainEntryKey(e) === chainEntryKey(newEntry))) {
        statusLine = `${chainEntryKey(newEntry)} already in chain`;
        mode = "list";
        input.setValue("");
        refresh();
        return;
      }
      working = [...working, newEntry];
      selectedIndex = working.length - 1;
      statusLine = `Added ${chainEntryKey(newEntry)} at end`;
      mode = "list";
      input.setValue("");
      refresh();
    }

    function renderAll() {
      const lines: string[] = [];
      lines.push(theme.fg("accent", "── Fallback Chain Editor ──"));
      lines.push(theme.fg("muted", `Mode: ${mode}    Selected: ${selectedIndex + 1}/${working.length || 1}    Current: ${currentIndexInChain >= 0 ? currentIndexInChain + 1 : "off-chain"}`));
      if (mode === "list") {
        if (working.length === 0) {
          lines.push(theme.fg("warning", "  (empty chain — nothing to fall back to)"));
        } else {
          for (let i = 0; i < working.length; i++) {
            const e = working[i];
            const isCur = i === currentIndexInChain;
            const marker = isCur ? theme.fg("success", " ● ") : "   ";
            const cursor = i === selectedIndex ? theme.fg("accent", "→ ") : "  ";
            const idx = theme.fg("muted", `${(i + 1).toString().padStart(2, " ")}. `);
            const label = `${e.provider}/${e.id}`;
            const name = e.name ? theme.fg("dim", ` (${e.name})`) : "";
            const sickKey = chainEntryKey(e);
            const sick = isSick(sickKey);
            const sickTag = sick ? theme.fg("warning", " [sick]") : "";
            lines.push(`${cursor}${marker}${idx}${label}${name}${sickTag}`);
          }
        }
        lines.push("");
        lines.push(theme.fg("dim", "a:add  d:remove  u/k:move up  U/j:move down  e:rename  enter:save  q:quit"));
      } else if (mode === "add") {
        lines.push(theme.fg("accent", "Search model to add (fuzzy, like /model):"));
        lines.push("  " + input.getValue() + "_");
        lines.push("");
        const q = input.getValue();
        if (q) {
          const allModels = ctx.modelRegistry.getAvailable();
          const matched = fuzzyFilter(
            allModels.map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
            q,
            (item) => `${item.provider}/${item.id} ${item.name ?? ""}`,
          ).slice(0, 8);
          for (const m of matched) {
            lines.push(theme.fg("muted", `   ${m.provider}/${m.id}`));
          }
        }
        lines.push("");
        lines.push(theme.fg("dim", "enter:add first match  esc:cancel"));
      } else if (mode === "edit-name" && nameEditIndex >= 0 && nameEditIndex < working.length) {
        lines.push(theme.fg("accent", `Rename ${chainEntryKey(working[nameEditIndex])}:`));
        lines.push("  " + input.getValue() + "_");
        lines.push("");
        lines.push(theme.fg("dim", "enter:save name  esc:cancel"));
      }
      if (statusLine) lines.push(theme.fg("warning", statusLine));
      lines.push(theme.fg("accent", "────────────────────────────────"));
      for (const line of lines) {
        listContainer.addChild(new Text(line, 0, 0));
      }
    }

    function handleInput(data: string) {
      if (mode === "add" || mode === "edit-name") {
        if (matchesKey(data, Key.escape)) {
          mode = "list";
          input.setValue("");
          statusLine = "";
          refresh();
          return;
        }
        input.handleInput(data);
        refresh();
        return;
      }
      // list mode
      if (matchesKey(data, Key.up) || data === "k") {
        if (working.length > 0) {
          selectedIndex = (selectedIndex - 1 + working.length) % working.length;
          refresh();
        }
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
        if (working.length > 0) {
          selectedIndex = (selectedIndex + 1) % working.length;
          refresh();
        }
        return;
      }
      if (data === "a") {
        mode = "add";
        input.setValue("");
        statusLine = "";
        refresh();
        return;
      }
      if (data === "d" && working.length > 0) {
        const removed = working.splice(selectedIndex, 1)[0];
        statusLine = `Removed ${chainEntryKey(removed)}`;
        selectedIndex = Math.max(0, selectedIndex - 1);
        refresh();
        return;
      }
      if (data === "u" && working.length > 0 && selectedIndex > 0) {
        const [item] = working.splice(selectedIndex, 1);
        working.splice(selectedIndex - 1, 0, item);
        selectedIndex -= 1;
        statusLine = "Moved up";
        refresh();
        return;
      }
      if (data === "U" && working.length > 0 && selectedIndex < working.length - 1) {
        const [item] = working.splice(selectedIndex, 1);
        working.splice(selectedIndex + 1, 0, item);
        selectedIndex += 1;
        statusLine = "Moved down";
        refresh();
        return;
      }
      if (data === "e" && working.length > 0) {
        mode = "edit-name";
        nameEditIndex = selectedIndex;
        const cur = working[selectedIndex];
        input.setValue(cur.name ?? "");
        statusLine = "";
        refresh();
        return;
      }
      if (data === "q" || matchesKey(data, Key.escape)) {
        done_("cancel");
        return;
      }
      if (matchesKey(data, Key.enter)) {
        done_("commit");
        return;
      }
    }

    refresh();
    return {
      render: (width: number) => listContainer.render(width),
      invalidate: () => { listContainer.clear(); refresh(); },
      handleInput,
    };
  });
  return result;
}

async function openChainEditorSimple(
  ctx: ExtensionContext,
  initialChain: ChainEntry[],
): Promise<ChainEditorResult> {
  const cfg_ = (await import("./config.js")).loadConfig();
  const items: string[] = [];
  for (let i = 0; i < cfg_.chain.length; i++) {
    const e = cfg_.chain[i];
    items.push(`${i + 1}. ${e.provider}/${e.id}${e.name ? ` (${e.name})` : ""}`);
  }
  items.push("--- ADD A MODEL ---");
  items.push("--- REMOVE ALL ---");
  const choice = await ctx.ui.select("Fallback chain", items);
  if (!choice) return { action: "cancel", chain: initialChain };
  if (choice.startsWith("--- REMOVE ALL")) {
    const { saveConfig } = await import("./config.js");
    saveConfig({ ...cfg_, chain: [] });
    return { action: "commit", chain: [] };
  }
  if (choice.startsWith("--- ADD A MODEL")) {
    const available = ctx.modelRegistry.getAvailable();
    if (available.length === 0) {
      ctx.ui.notify("No models available", "error");
      return { action: "noop", chain: initialChain };
    }
    const picked = await ctx.ui.select(
      "Pick a model to add",
      available.map((m) => `${m.provider}/${m.id}${m.name ? ` (${m.name})` : ""}`),
    );
    if (!picked) return { action: "cancel", chain: initialChain };
    const slash = picked.indexOf("/");
    const provider = picked.slice(0, slash);
    const rest = picked.slice(slash + 1).split(" ")[0];
    const newChain = [...cfg_.chain, { provider, id: rest }];
    const { saveConfig } = await import("./config.js");
    saveConfig({ ...cfg_, chain: newChain });
    return { action: "commit", chain: newChain };
  }
  const idx = parseInt(choice.split(".")[0], 10) - 1;
  if (idx >= 0 && idx < cfg_.chain.length) {
    const newChain = cfg_.chain.filter((_, i) => i !== idx);
    const { saveConfig } = await import("./config.js");
    saveConfig({ ...cfg_, chain: newChain });
    return { action: "commit", chain: newChain };
  }
  return { action: "noop", chain: initialChain };
}

// ─── Condition editor ───────────────────────────────────────────────────────

export interface ConditionResult {
  triggers: Triggers;
}

export async function openConditionEditor(
  ctx: ExtensionContext,
  initial: Triggers,
): Promise<ConditionResult> {
  if (ctx.mode !== "tui") return openConditionEditorSimple(ctx, initial);

  type Field = {
    key: keyof Triggers;
    label: string;
    min: number;
    max: number;
    suffix: string;
    help: string;
  };
  const fields: Field[] = [
    { key: "timeoutMs",              label: "Per-request timeout (ms, 0=off)",  min: 0,    max: 24 * 3600_000, suffix: "ms",  help: "Abort a request that stalls this long with no progress" },
    { key: "consecutiveErrors",      label: "Consecutive errors to fallback",  min: 0,    max: 100,            suffix: "",    help: "0 disables; otherwise N errors in a row triggers fallback" },
    { key: "errorsInWindow",         label: "Errors-in-window to fallback",    min: 0,    max: 1000,           suffix: "",    help: "0 disables; otherwise N errors in windowMs triggers fallback" },
    { key: "windowMs",               label: "Errors-window size (ms)",         min: 1000, max: 24 * 3600_000, suffix: "ms",  help: "Window for errorsInWindow counter" },
    { key: "retriesBeforeFallback",  label: "Same-model retries",              min: 0,    max: 50,             suffix: "",    help: "How many times to retry the SAME model before falling back" },
    { key: "retryDelayMs",           label: "Retry delay (ms)",                min: 0,    max: 600_000,        suffix: "ms",  help: "Delay between same-model retries" },
    { key: "maxFallbacksPerSession", label: "Max fallbacks per session (0=∞)", min: 0,    max: 1000,           suffix: "",    help: "Safety bound on auto-fallbacks in one session" },
    { key: "skipFailingForMs",       label: "Skip failing for (ms, 0=off)",    min: 0,    max: 24 * 3600_000, suffix: "ms",  help: "Mark a model sick for this long after it fails" },
  ];

  const result = await ctx.ui.custom<ConditionResult>((tui, theme, _kb, done) => {
    let working: Triggers = { ...initial };
    let fieldIndex = 0;
    let editingField = false;
    const input = new Input();
    let statusLine = "";

    const listContainer = new Container();
    function refresh() {
      listContainer.clear();
      const lines: string[] = [];
      lines.push(theme.fg("accent", "── Fallback Triggers ──"));
      lines.push(theme.fg("muted", "↑↓ to navigate, Enter to edit a number, type then Enter to save. 'p' toggles promoteWhenHealthy."));
      lines.push("");
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const cursor = i === fieldIndex ? theme.fg("accent", "→ ") : "  ";
        const isEditing = editingField && i === fieldIndex;
        const labelColor = isEditing ? "accent" : "text";
        const value = working[f.key];
        const valueStr = isEditing ? `${input.getValue()}_` : `${value}${f.suffix ? " " + f.suffix : ""}`;
        lines.push(`${cursor}${theme.fg(labelColor, f.label)}: ${theme.fg("muted", valueStr)}`);
        if (isEditing) lines.push(theme.fg("dim", `     ${f.help}`));
      }
      lines.push("");
      const promoteStr = working.promoteWhenHealthy
        ? theme.fg("success", "on")
        : theme.fg("muted", "off");
      lines.push(`  promoteWhenHealthy: ${promoteStr}  (p to toggle)`);
      if (statusLine) lines.push(theme.fg("warning", statusLine));
      lines.push("");
      lines.push(theme.fg("dim", "↑↓ navigate • enter edit • esc cancel"));
      lines.push(theme.fg("accent", "──────────────────────"));
      for (const l of lines) listContainer.addChild(new Text(l, 0, 0));
      tui.requestRender();
    }

    function setField(key: keyof Triggers, raw: string): boolean {
      const n = Number.parseInt(raw, 10);
      const field = fields.find((f) => f.key === key)!;
      if (!Number.isFinite(n) || n < field.min || n > field.max) {
        statusLine = `Invalid: ${field.label} must be ${field.min}..${field.max}`;
        return false;
      }
      (working as unknown as Record<string, number>)[key] = n;
      statusLine = `Set ${field.label} = ${n}`;
      return true;
    }

    function handleInput(data: string) {
      if (editingField) {
        if (matchesKey(data, Key.escape)) {
          editingField = false;
          input.setValue("");
          statusLine = "Edit cancelled";
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          if (setField(fields[fieldIndex].key, input.getValue())) {
            editingField = false;
            input.setValue("");
          }
          refresh();
          return;
        }
        input.handleInput(data);
        refresh();
        return;
      }
      if (matchesKey(data, Key.up)) {
        fieldIndex = (fieldIndex - 1 + fields.length) % fields.length;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        fieldIndex = (fieldIndex + 1) % fields.length;
        refresh();
        return;
      }
      if (data === "p") {
        working.promoteWhenHealthy = !working.promoteWhenHealthy;
        statusLine = `promoteWhenHealthy = ${working.promoteWhenHealthy}`;
        refresh();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        done({ triggers: { ...initial } });
        return;
      }
      if (matchesKey(data, Key.enter)) {
        editingField = true;
        const f = fields[fieldIndex];
        input.setValue(String(working[f.key]));
        statusLine = `Editing ${f.label}`;
        refresh();
        return;
      }
    }

    refresh();
    return {
      render: (w: number) => listContainer.render(w),
      invalidate: () => { listContainer.clear(); refresh(); },
      handleInput,
    };
  });

  return result;
}

async function openConditionEditorSimple(
  ctx: ExtensionContext,
  initial: Triggers,
): Promise<ConditionResult> {
  const labels = [
    `timeoutMs = ${initial.timeoutMs}`,
    `consecutiveErrors = ${initial.consecutiveErrors}`,
    `errorsInWindow = ${initial.errorsInWindow}`,
    `windowMs = ${initial.windowMs}`,
    `retriesBeforeFallback = ${initial.retriesBeforeFallback}`,
    `retryDelayMs = ${initial.retryDelayMs}`,
    `maxFallbacksPerSession = ${initial.maxFallbacksPerSession}`,
    `skipFailingForMs = ${initial.skipFailingForMs}`,
    `promoteWhenHealthy = ${initial.promoteWhenHealthy}`,
  ];
  const pick = await ctx.ui.select("Trigger to edit", [...labels, "── save all ──"]);
  if (!pick) return { triggers: initial };
  if (pick === "── save all ──") {
    const { loadConfig, saveConfig } = await import("./config.js");
    const cfg = loadConfig();
    saveConfig({ ...cfg, triggers: initial });
    return { triggers: initial };
  }
  const key = pick.split(" = ")[0];
  const raw = await ctx.ui.input(`New value for ${key}`, String((initial as unknown as Record<string, unknown>)[key]));
  if (raw === undefined) return { triggers: initial };
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    ctx.ui.notify(`Invalid number: ${raw}`, "error");
    return { triggers: initial };
  }
  const next: Triggers = { ...initial };
  (next as unknown as Record<string, number | boolean>)[key] = n;
  return openConditionEditorSimple(ctx, next);
}

// ─── Model picker ───────────────────────────────────────────────────────────

export async function openModelPicker(
  ctx: ExtensionContext,
  title: string,
): Promise<ChainEntry | null> {
  const available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) {
    ctx.ui.notify("No models available in registry", "error");
    return null;
  }
  if (ctx.mode !== "tui") {
    const labels = available.map((m) => `${m.provider}/${m.id}${m.name ? ` (${m.name})` : ""}`);
    const picked = await ctx.ui.select(title, labels);
    if (!picked) return null;
    const slash = picked.indexOf("/");
    const provider = picked.slice(0, slash);
    const id = picked.slice(slash + 1).split(" ")[0];
    const name = available.find((m) => m.provider === provider && m.id === id)?.name;
    return { provider, id, name };
  }
  const result = await ctx.ui.custom<ChainEntry | null>((tui, theme, _kb, done) => {
    let idx = 0;
    const input = new Input();
    const listContainer = new Container();

    function matched(): { m: Model<any> }[] {
      return fuzzyFilter(
        available.map((m) => ({ m })),
        input.getValue(),
        ({ m }) => `${m.provider}/${m.id} ${m.name ?? ""}`,
      );
    }

    function refresh() {
      listContainer.clear();
      const m = matched();
      if (m.length === 0) idx = 0;
      else if (idx >= m.length) idx = m.length - 1;
      const lines: string[] = [];
      lines.push(theme.fg("accent", `── ${title} ──`));
      lines.push(theme.fg("muted", "type to fuzzy-filter; ↑↓ pick; enter select; esc cancel"));
      lines.push("");
      lines.push(`  ${input.getValue()}_`);
      lines.push("");
      const max = 10;
      const start = Math.max(0, Math.min(idx - Math.floor(max / 2), m.length - max));
      const end = Math.min(start + max, m.length);
      for (let i = start; i < end; i++) {
        const item = m[i];
        const cursor = i === idx ? theme.fg("accent", "→ ") : "  ";
        const label = `${item.m.provider}/${item.m.id}`;
        const sick = isSick(`${item.m.provider}/${item.m.id}`);
        const sickTag = sick ? theme.fg("warning", " [sick]") : "";
        lines.push(`${cursor}${label}${theme.fg("dim", `  ${item.m.name ?? ""}`)}${sickTag}`);
      }
      if (m.length === 0) lines.push(theme.fg("warning", "  (no matches)"));
      lines.push("");
      lines.push(theme.fg("muted", `  ${m.length} of ${available.length} models`));
      lines.push(theme.fg("accent", "────────────────────────────"));
      for (const l of lines) listContainer.addChild(new Text(l, 0, 0));
      tui.requestRender();
    }

    function handleInput(data: string) {
      if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const m = matched();
        const pick = m[idx];
        if (pick) {
          done({ provider: pick.m.provider, id: pick.m.id, name: pick.m.name });
        } else {
          done(null);
        }
        return;
      }
      if (matchesKey(data, Key.up)) {
        const m = matched();
        if (m.length > 0) idx = (idx - 1 + m.length) % m.length;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        const m = matched();
        if (m.length > 0) idx = (idx + 1) % m.length;
        refresh();
        return;
      }
      input.handleInput(data);
      idx = 0;
      refresh();
    }

    refresh();
    return {
      render: (w: number) => listContainer.render(w),
      invalidate: () => listContainer.clear(),
      handleInput,
    };
  });
  return result ?? null;
}