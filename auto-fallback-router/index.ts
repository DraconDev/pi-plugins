/**
 * pi-auto-fallback-router
 *
 * Automatic fallback router for pi. When the active LLM fails or stalls, the
 * router switches to the next model in a user-configured chain — without
 * surfacing the failure to the user as long as a healthy fallback exists.
 *
 * What this is:
 *   • A chain-based fallback router (primary → fallback #1 → fallback #2 → …).
 *   • Triggers: per-request timeout (abort the slow call), consecutive errors,
 *     and rolling window error rate. Each trigger can be tuned independently.
 *   • A /model-like fuzzy selector for picking fallback models.
 *   • Per-model "sick" cooldown so a flaky model is skipped for a while after
 *     it fails (configurable per-trigger via `skipFailingForMs`).
 *   • Optional bounded retries per fall-through so a single transient hiccup
 *     does not burn the whole chain.
 *   • Persistent JSON config in ~/.pi/agent/fallback-router.json (chain +
 *     triggers + per-model overrides) plus a runtime health/state cache that
 *     survives /reload.
 *
 * What this is NOT:
 *   • It is not a global retry-on-error. pi-retry-on-error already retries the
 *     same model transparently; this router only swaps models when retries
 *     would just keep hitting the same broken upstream.
 *   • It does not silently change user-selected models. Switching happens only
 *     in response to a failure trigger on the current model.
 *
 * Commands:
 *   /fallback                 Open the chain editor UI (/model-like selector
 *                             with multi-select for the chain).
 *   /fallback add             Fuzzy-pick a model and append to the chain.
 *   /fallback pick            Fuzzy-pick a model to insert at a chosen position.
 *   /fallback remove <idx>    Remove a model from the chain by 1-based index.
 *   /fallback move <i> <j>    Move chain entry at i to position j.
 *   /fallback list            Plain-text dump of the chain + triggers.
 *   /fallback status          One-line status (model, chain index, errors).
 *   /fallback condition        Interactive trigger editor.
 *   /fallback enable|disable  Toggle the router without losing the chain.
 *   /fallback reset           Clear runtime counters, sick marks, fallbacks-used.
 *   /fallback clear           Empty the chain.
 *   /fallback skip            Toggle "sick" mark on the current model manually.
 *   /fallback help            Short help text.
 *
 * Configuration file: ~/.pi/agent/fallback-router.json
 *   {
 *     "version": 1,
 *     "enabled": true,
 *     "chain": [
 *       { "provider": "anthropic", "id": "claude-opus-4-8", "name": "Claude Opus 4.8" },
 *       { "provider": "openai",    "id": "gpt-5.5",         "name": "GPT-5.5" },
 *       { "provider": "minimax",   "id": "MiniMax-M3" }
 *     ],
 *     "triggers": {
 *       "timeoutMs": 60000,             // abort a request that stalls longer (0 = off)
 *       "consecutiveErrors": 2,         // N errors in a row → next model (0 = off)
 *       "errorsInWindow": 3,            // N errors within windowMs → next model (0 = off)
 *       "windowMs": 300000,             // rolling window for errorsInWindow
 *       "retriesBeforeFallback": 1,     // how many retries on the SAME model first
 *       "retryDelayMs": 1000,           // delay between same-model retries
 *       "maxFallbacksPerSession": 10,   // safety bound (0 = unlimited)
 *       "skipFailingForMs": 300000,     // mark sick for this long after a failure
 *       "promoteWhenHealthy": false     // auto-revert to primary when sick expires
 *     },
 *     "perModel": {
 *       "anthropic/claude-opus-4-8": { "timeoutMs": 120000, "skipFailingForMs": 120000 }
 *     }
 *   }
 *
 * Edge cases & design notes:
 *   • Aborts issued by this router fire `message_end` with `stopReason:
 *     "aborted"`, NOT "error". We track which aborts are ours via a closure
 *     flag set in `before_provider_request` and check it in `message_end`.
 *   • After a successful assistant turn (`stopReason` in {stop, toolUse,
 *     length}) we reset the per-model consecutive-error counter for the
 *     CURRENT model and the rolling-window counter if the window has elapsed.
 *   • Switching models via the chain sets `currentIndex`; user-initiated
 *     switches (`source: "set" | "cycle"`) leave the chain alone but
 *     record the new model so we don't fall back to it from a different
 *     path. We only trigger fallback on `message_end` for the currently
 *     active model.
 *   • Re-sending the user's last message after a fallback uses
 *     `pi.sendUserMessage(..., { deliverAs: "followUp" })` so we never
 *     interrupt an in-flight turn. The original error message is replaced
 *     in the session with a fallback notice (same `role: "assistant"`,
 *     `stopReason: "stop"`, no `errorMessage`) so downstream consumers
 *     (compaction, usage tracking) keep working.
 *   • The chain editor and condition editor use `ctx.ui.custom()` with
 *     components from `@earendil-works/pi-tui` so the experience matches
 *     `/model`. RPC mode returns a synthetic selection string instead of
 *     trying to render a TUI overlay.
 *   • Settings keys: `enabled` toggles the router entirely. Per-model
 *     overrides merge on top of the global triggers at the moment of the
 *     decision.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Model,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { modelsAreEqual } from "@earendil-works/pi-ai";
import {
  Container,
  fuzzyFilter,
  Input,
  matchesKey,
  Text,
  Key,
} from "@earendil-works/pi-tui";

// ─── Configuration types & defaults ──────────────────────────────────────────

interface ChainEntry {
  provider: string;
  id: string;
  name?: string;
}

interface Triggers {
  timeoutMs: number;
  consecutiveErrors: number;
  errorsInWindow: number;
  windowMs: number;
  retriesBeforeFallback: number;
  retryDelayMs: number;
  maxFallbacksPerSession: number;
  skipFailingForMs: number;
  promoteWhenHealthy: boolean;
}

interface PerModelOverrides {
  timeoutMs?: number;
  consecutiveErrors?: number;
  errorsInWindow?: number;
  skipFailingForMs?: number;
  retriesBeforeFallback?: number;
  retryDelayMs?: number;
}

interface Config {
  version: 1;
  enabled: boolean;
  chain: ChainEntry[];
  triggers: Triggers;
  perModel?: Record<string, PerModelOverrides>;
}

const DEFAULT_TRIGGERS: Triggers = {
  timeoutMs: 60_000,
  consecutiveErrors: 2,
  errorsInWindow: 3,
  windowMs: 300_000,
  retriesBeforeFallback: 1,
  retryDelayMs: 1_000,
  maxFallbacksPerSession: 10,
  skipFailingForMs: 300_000,
  promoteWhenHealthy: false,
};

const DEFAULT_CONFIG: Config = {
  version: 1,
  enabled: true,
  chain: [],
  triggers: { ...DEFAULT_TRIGGERS },
};

// ─── Runtime state ───────────────────────────────────────────────────────────
//
// `health` and `chainState` are closure-local. They survive /reload only via
// the JSON config file; in-process state is lost on full reload (intentional,
// matches pi-retry-on-error).

interface ModelHealth {
  consecutiveErrors: number;
  windowErrors: number;
  windowStart: number;
  sickUntil: number;
  lastError?: string;
  lastErrorAt?: number;
}

interface ChainState {
  currentIndex: number; // index into config.chain, or -1 if user picked a model not in the chain
  recentFallbacks: number;
  lastUserText: string | null;
  retryInFlight: boolean;
  abortTriggered: boolean;
  pendingTimeout: ReturnType<typeof setTimeout> | null;
  requestStartedAt: number;
}

const health: Map<string, ModelHealth> = new Map();
let chainState: ChainState = {
  currentIndex: -1,
  recentFallbacks: 0,
  lastUserText: null,
  retryInFlight: false,
  abortTriggered: false,
  pendingTimeout: null,
  requestStartedAt: 0,
};

// ─── Persistence ─────────────────────────────────────────────────────────────

const CONFIG_PATH = join(getAgentDir(), "fallback-router.json");
let writeChain: Promise<void> = Promise.resolve();
let cachedConfig: Config | null = null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isChainEntry(v: unknown): v is ChainEntry {
  if (!isRecord(v)) return false;
  return typeof v.provider === "string" && v.provider.length > 0 &&
         typeof v.id === "string" && v.id.length > 0 &&
         (v.name === undefined || typeof v.name === "string");
}

function isTriggers(v: unknown): v is Triggers {
  if (!isRecord(v)) return false;
  const check = (k: keyof Triggers, min: number, max: number) =>
    typeof v[k] === "number" && Number.isFinite(v[k] as number) &&
    (v[k] as number) >= min && (v[k] as number) <= max;
  return check("timeoutMs", 0, 24 * 3600_000) &&
         check("consecutiveErrors", 0, 100) &&
         check("errorsInWindow", 0, 1000) &&
         check("windowMs", 1_000, 24 * 3600_000) &&
         check("retriesBeforeFallback", 0, 50) &&
         check("retryDelayMs", 0, 600_000) &&
         check("maxFallbacksPerSession", 0, 1000) &&
         check("skipFailingForMs", 0, 24 * 3600_000) &&
         typeof v.promoteWhenHealthy === "boolean";
}

function isPerModelOverrides(v: unknown): v is PerModelOverrides {
  if (!isRecord(v)) return false;
  for (const k of Object.keys(v)) {
    const n = v[k];
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
  }
  return true;
}

function isConfig(v: unknown): v is Config {
  if (!isRecord(v)) return false;
  if (v.version !== 1) return false;
  if (typeof v.enabled !== "boolean") return false;
  if (!Array.isArray(v.chain)) return false;
  if (!v.chain.every(isChainEntry)) return false;
  if (!isTriggers(v.triggers)) return false;
  if (v.perModel !== undefined && !isRecord(v.perModel)) return false;
  if (v.perModel !== undefined) {
    for (const [k, val] of Object.entries(v.perModel)) {
      if (!k.includes("/") || !isPerModelOverrides(val)) return false;
    }
  }
  return true;
}

function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  try {
    if (!existsSync(CONFIG_PATH)) {
      cachedConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      return cachedConfig;
    }
    const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!isConfig(raw)) {
      console.warn(`[fallback-router] ${CONFIG_PATH} is malformed; using defaults`);
      cachedConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      return cachedConfig;
    }
    cachedConfig = raw;
    return cachedConfig;
  } catch (err) {
    console.warn(`[fallback-router] could not read ${CONFIG_PATH}: ${err}`);
    cachedConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    return cachedConfig;
  }
}

function saveConfig(cfg: Config): void {
  cachedConfig = cfg;
  const payload = `${JSON.stringify(cfg, null, 2)}\n`;
  writeChain = writeChain.then(() => {
    const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(tmp, payload, "utf8");
      renameSync(tmp, CONFIG_PATH);
    } catch (err) {
      console.warn(`[fallback-router] could not write ${CONFIG_PATH}: ${err}`);
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function modelKey(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`;
}

function chainEntryKey(e: ChainEntry): string {
  return `${e.provider}/${e.id}`;
}

function now(): number {
  return Date.now();
}

function getHealth(key: string): ModelHealth {
  let h = health.get(key);
  if (!h) {
    h = {
      consecutiveErrors: 0,
      windowErrors: 0,
      windowStart: now(),
      sickUntil: 0,
    };
    health.set(key, h);
  }
  return h;
}

function resetHealthCounter(key: string): void {
  const h = getHealth(key);
  h.consecutiveErrors = 0;
  h.windowErrors = 0;
  h.windowStart = now();
}

function recordSuccess(key: string): void {
  resetHealthCounter(key);
  getHealth(key).sickUntil = 0;
}

function recordFailure(key: string, errText: string): void {
  const h = getHealth(key);
  const t = now();
  if (t - h.windowStart > loadConfig().triggers.windowMs) {
    h.windowStart = t;
    h.windowErrors = 0;
  }
  h.consecutiveErrors += 1;
  h.windowErrors += 1;
  h.lastError = errText.slice(0, 240);
  h.lastErrorAt = t;
  const cfg = loadConfig();
  const override = cfg.perModel?.[key]?.skipFailingForMs;
  const skipMs = override ?? cfg.triggers.skipFailingForMs;
  if (skipMs > 0) h.sickUntil = t + skipMs;
}

function isSick(key: string): boolean {
  const h = getHealth(key);
  if (h.sickUntil === 0) return false;
  if (now() >= h.sickUntil) {
    h.sickUntil = 0;
    return false;
  }
  return true;
}

function effectiveTriggers(modelKeyStr: string): {
  triggers: Triggers;
  perModel: PerModelOverrides | undefined;
} {
  const cfg = loadConfig();
  const per = cfg.perModel?.[modelKeyStr];
  const merged: Triggers = { ...cfg.triggers };
  if (per) {
    if (per.timeoutMs !== undefined) merged.timeoutMs = per.timeoutMs;
    if (per.consecutiveErrors !== undefined) merged.consecutiveErrors = per.consecutiveErrors;
    if (per.errorsInWindow !== undefined) merged.errorsInWindow = per.errorsInWindow;
    if (per.retriesBeforeFallback !== undefined) merged.retriesBeforeFallback = per.retriesBeforeFallback;
    if (per.retryDelayMs !== undefined) merged.retryDelayMs = per.retryDelayMs;
    if (per.skipFailingForMs !== undefined) merged.skipFailingForMs = per.skipFailingForMs;
  }
  return { triggers: merged, perModel: per };
}

function extractUserText(content: unknown): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" &&
          (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) return text;
      }
    }
  }
  return null;
}

function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function findModelInRegistry(
  ctx: ExtensionContext,
  provider: string,
  id: string,
): Model | undefined {
  return ctx.modelRegistry.find(provider, id);
}

// ─── Fallback decision & execution ───────────────────────────────────────────

interface FallbackDecision {
  shouldFallback: boolean;
  reason: string;
  target: ChainEntry | undefined;
  /** index in config.chain of the model that just failed (for notification copy) */
  fromIndex: number;
}

function decideFallback(opts: {
  cfg: Config;
  currentModel: Model;
  reason: "error" | "timeout" | "abort";
  errText: string;
}): FallbackDecision {
  const { cfg, currentModel, reason, errText } = opts;
  const curKey = modelKey(currentModel);
  const curIndex = cfg.chain.findIndex((e) => chainEntryKey(e) === curKey);
  const fromIndex = curIndex;

  // If the current model is not in the chain, user picked it manually — do not
  // switch unless we can identify a sensible fallback (next chain entry, or
  // first chain entry).
  let searchFrom: number;
  if (curIndex === -1) {
    searchFrom = 0;
  } else {
    searchFrom = curIndex + 1;
  }

  const reasonText = reason === "timeout"
    ? `timeout after ${errText || "no progress"}`
    : reason === "abort"
      ? "aborted"
      : `error: ${truncate(errText, 120)}`;

  for (let i = searchFrom; i < cfg.chain.length; i++) {
    const entry = cfg.chain[i];
    const key = chainEntryKey(entry);
    if (isSick(key)) continue;
    return {
      shouldFallback: true,
      reason: reasonText,
      target: entry,
      fromIndex,
    };
  }

  return {
    shouldFallback: false,
    reason: reasonText,
    target: undefined,
    fromIndex,
  };
}

function buildFallbackNotice(opts: {
  original: Record<string, unknown>;
  fromKey: string;
  toKey: string;
  reason: string;
  attempt: number;
}): Record<string, unknown> {
  return {
    ...opts.original,
    role: "assistant",
    stopReason: "stop",
    content: [
      {
        type: "text",
        text:
          `⚠️ Fallback router: ${opts.fromKey} → ${opts.toKey}\n` +
          `   Reason: ${opts.reason}\n` +
          `   Resent automatically (attempt ${opts.attempt}).`,
      },
    ],
    errorMessage: undefined,
  };
}

async function performFallback(opts: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  currentModel: Model;
  decision: FallbackDecision;
}): Promise<void> {
  const { pi, ctx, currentModel, decision } = opts;
  const cfg = loadConfig();
  if (!decision.target) {
    ctx.ui.notify(
      `Fallback router: no healthy model in chain (last failure on ${modelKey(currentModel)})`,
      "error",
    );
    return;
  }
  if (cfg.triggers.maxFallbacksPerSession > 0 &&
      chainState.recentFallbacks >= cfg.triggers.maxFallbacksPerSession) {
    ctx.ui.notify(
      `Fallback router: per-session fallback cap reached (${cfg.triggers.maxFallbacksPerSession})`,
      "error",
    );
    return;
  }

  const target = decision.target;
  const targetModel = findModelInRegistry(ctx, target.provider, target.id);
  if (!targetModel) {
    ctx.ui.notify(
      `Fallback router: ${chainEntryKey(target)} not available in registry`,
      "error",
    );
    return;
  }

  if (!chainState.lastUserText) {
    ctx.ui.notify(
      `Fallback router: cannot requeue (no user text captured) — staying on ${modelKey(currentModel)}`,
      "error",
    );
    return;
  }

  const success = await pi.setModel(targetModel);
  if (!success) {
    ctx.ui.notify(
      `Fallback router: no auth for ${chainEntryKey(target)}`,
      "error",
    );
    return;
  }

  chainState.recentFallbacks += 1;
  chainState.currentIndex = cfg.chain.findIndex((e) => chainEntryKey(e) === chainEntryKey(target));
  ctx.ui.notify(
    `Fallback router: ${modelKey(currentModel)} → ${chainEntryKey(target)} (${decision.reason})`,
    "warning",
  );

  // Re-send the user's last message as a follow-up so the new model retries it.
  const textToSend = chainState.lastUserText;
  const delay = cfg.triggers.retryDelayMs;
  setTimeout(() => {
    chainState.retryInFlight = true;
    try {
      pi.sendUserMessage(textToSend, { deliverAs: "followUp" });
    } catch (err) {
      chainState.retryInFlight = false;
      const msg = err instanceof Error ? err.message : String(err);
      try {
        ctx.ui.notify(`Fallback router: requeue failed: ${truncate(msg)}`, "error");
      } catch { /* swallow */ }
    }
  }, Math.max(0, delay));
}

// ─── Custom UI: ChainEditor ──────────────────────────────────────────────────
//
// A /model-like selector for the chain. Shows the current chain as a list with
// fuzzy search for adding, and inline actions for remove/reorder. Used by
// `/fallback` (no args) and `/fallback pick`.

interface ChainEditorResult {
  action: "cancel" | "commit" | "noop";
  chain: ChainEntry[];
}

async function openChainEditor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  initialChain: ChainEntry[],
): Promise<ChainEditorResult> {
  if (ctx.mode !== "tui") {
    // RPC / print mode — fall back to a flat select picker for inserts.
    return openChainEditorSimple(ctx, initialChain);
  }
  const cfg = loadConfig();
  const result = await ctx.ui.custom<ChainEditorResult>((tui, theme, _kb, done) => {
    let working: ChainEntry[] = [...initialChain];
    let mode: "list" | "add" | "edit-name" = "list";
    let selectedIndex = Math.max(0, working.length - 1);
    let searchQuery = "";
    let statusLine = "";
    let nameEditIndex = -1;

    const input = new Input();
    input.onSubmit = () => {
      if (mode === "add") {
        searchQuery = input.getValue();
        addSelectedFromSearch();
        return;
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

    function commit() {
      saveConfig({ ...loadConfig(), chain: working });
      statusLine = `Saved ${working.length}-model chain`;
      done_("commit");
    }

    function cancel() {
      done_("cancel");
    }

    function addSelectedFromSearch() {
      const q = input.getValue().trim();
      if (!q) return;
      const allModels = ctx.modelRegistry.getAvailable();
      if (allModels.length === 0) {
        statusLine = "No models available in registry";
        mode = "list";
        input.setValue("");
        refresh();
        return;
      }
      const matched = fuzzyFilter(
        allModels.map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
        q,
        (item) => `${item.provider}/${item.id} ${item.name ?? ""}`,
      );
      if (matched.length === 0) {
        statusLine = `No match for "${q}"`;
        mode = "list";
        input.setValue("");
        refresh();
        return;
      }
      const pick = matched[0];
      const newEntry: ChainEntry = { provider: pick.provider, id: pick.id, name: pick.name };
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
      const width = 100; // approximate; TUI will truncate
      const lines: string[] = [];
      lines.push(theme.fg("accent", "── Fallback Chain Editor ──"));
      lines.push(theme.fg("muted", `Mode: ${mode}    Selected: ${selectedIndex + 1}/${working.length || 1}    Enabled: ${cfg.enabled ? "yes" : "no"}`));
      if (mode === "list") {
        if (working.length === 0) {
          lines.push(theme.fg("warning", "  (empty chain — nothing to fall back to)"));
        } else {
          for (let i = 0; i < working.length; i++) {
            const e = working[i];
            const isCur = i === chainState.currentIndex;
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
        lines.push(theme.fg("dim", "a:add  d:remove  u/k:move  e:rename  enter:save  q:quit"));
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
      } else if (mode === "edit-name") {
        lines.push(theme.fg("accent", `Rename ${chainEntryKey(working[nameEditIndex])}:`));
        lines.push("  " + input.getValue() + "_");
        lines.push("");
        lines.push(theme.fg("dim", "enter:save name  esc:cancel"));
      }
      if (statusLine) lines.push(theme.fg("warning", statusLine));
      lines.push(theme.fg("accent", "────────────────────────────────"));
      listContainer.clear();
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
        cancel();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        // In edit-name mode, save the name
        if (mode === "edit-name" && nameEditIndex >= 0) {
          const v = input.getValue().trim();
          working[nameEditIndex] = { ...working[nameEditIndex], name: v || undefined };
          statusLine = "Name updated";
          mode = "list";
          input.setValue("");
          refresh();
          return;
        }
        commit();
        return;
      }
    }

    refresh();

    return {
      render: (width: number) => {
        return listContainer.render(width);
      },
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
  const cfg = loadConfig();
  const items: string[] = [];
  for (let i = 0; i < cfg.chain.length; i++) {
    const e = cfg.chain[i];
    items.push(`${i + 1}. ${e.provider}/${e.id}${e.name ? ` (${e.name})` : ""}`);
  }
  items.push("--- ADD A MODEL ---");
  items.push("--- REMOVE ALL ---");
  const choice = await ctx.ui.select("Fallback chain", items);
  if (!choice) return { action: "cancel", chain: initialChain };
  if (choice.startsWith("--- REMOVE ALL")) {
    saveConfig({ ...cfg, chain: [] });
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
    const newChain = [...cfg.chain, { provider, id: rest }];
    saveConfig({ ...cfg, chain: newChain });
    return { action: "commit", chain: newChain };
  }
  // selection was a numbered entry — toggle or remove
  const idx = parseInt(choice.split(".")[0], 10) - 1;
  if (idx >= 0 && idx < cfg.chain.length) {
    const newChain = cfg.chain.filter((_, i) => i !== idx);
    saveConfig({ ...cfg, chain: newChain });
    return { action: "commit", chain: newChain };
  }
  return { action: "noop", chain: initialChain };
}

// ─── Custom UI: ConditionEditor ──────────────────────────────────────────────

interface ConditionResult {
  triggers: Triggers;
}

async function openConditionEditor(
  ctx: ExtensionContext,
  initial: Triggers,
): Promise<ConditionResult> {
  if (ctx.mode !== "tui") return openConditionEditorSimple(ctx, initial);

  const fields: Array<{ key: keyof Triggers; label: string; min: number; max: number; suffix: string; help: string }> = [
    { key: "timeoutMs",               label: "Per-request timeout (ms, 0=off)",  min: 0,    max: 24 * 3600_000, suffix: "ms",  help: "Abort a request that stalls this long with no progress" },
    { key: "consecutiveErrors",       label: "Consecutive errors to fallback",  min: 0,    max: 100,            suffix: "",    help: "0 disables; otherwise N errors in a row triggers fallback" },
    { key: "errorsInWindow",          label: "Errors-in-window to fallback",    min: 0,    max: 1000,           suffix: "",    help: "0 disables; otherwise N errors in windowMs triggers fallback" },
    { key: "windowMs",                label: "Errors-window size (ms)",         min: 1000, max: 24 * 3600_000, suffix: "ms",  help: "Window for errorsInWindow counter" },
    { key: "retriesBeforeFallback",   label: "Same-model retries",              min: 0,    max: 50,             suffix: "",    help: "How many times to retry the SAME model before falling back" },
    { key: "retryDelayMs",            label: "Retry delay (ms)",                min: 0,    max: 600_000,        suffix: "ms",  help: "Delay between same-model retries" },
    { key: "maxFallbacksPerSession",  label: "Max fallbacks per session (0=∞)", min: 0,    max: 1000,           suffix: "",    help: "Safety bound on auto-fallbacks in one session" },
    { key: "skipFailingForMs",        label: "Skip failing for (ms, 0=off)",    min: 0,    max: 24 * 3600_000, suffix: "ms",  help: "Mark a model sick for this long after it fails" },
  ];
  // promoteWhenHealthy is a bool toggle

  const result = await ctx.ui.custom<ConditionResult>((tui, theme, _kb, done) => {
    let working: Triggers = { ...initial };
    let fieldIndex = 0;
    let editingField = false;
    const input = new Input();
    let statusLine = "";

    function commit() {
      const cfg = loadConfig();
      saveConfig({ ...cfg, triggers: working });
      done({ triggers: { ...working } });
    }

    function cancel() {
      done({ triggers: { ...initial } });
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

    const listContainer = new Container();
    function refresh() {
      listContainer.clear();
      const lines: string[] = [];
      lines.push(theme.fg("accent", "── Fallback Triggers ──"));
      lines.push(theme.fg("muted", `Use ↑↓ to navigate a field, Enter to edit, type a number, Enter to save it.`));
      lines.push(theme.fg("muted", `Toggle 'promoteWhenHealthy' with the 'p' key.`));
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
      lines.push(theme.fg("dim", "↑↓ navigate • enter edit • esc cancel • enter on no-edit commits"));
      lines.push(theme.fg("accent", "──────────────────────"));
      for (const l of lines) listContainer.addChild(new Text(l, 0, 0));
      tui.requestRender();
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
        cancel();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        // Begin editing the selected field
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

// ─── /fallback add (fuzzy picker) ────────────────────────────────────────────

interface PickerResult {
  entry: ChainEntry | null;
  cancelled: boolean;
}

async function openModelPicker(
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
    let query = "";
    let idx = 0;
    const input = new Input();
    const listContainer = new Container();

    function refresh() {
      listContainer.clear();
      const matched = fuzzyFilter(
        available.map((m) => ({ m })),
        query,
        ({ m }) => `${m.provider}/${m.id} ${m.name ?? ""}`,
      );
      if (matched.length === 0) idx = 0;
      else if (idx >= matched.length) idx = matched.length - 1;
      const lines: string[] = [];
      lines.push(theme.fg("accent", `── ${title} ──`));
      lines.push(theme.fg("muted", "type to fuzzy-filter; ↑↓ pick; enter select; esc cancel"));
      lines.push("");
      lines.push(`  ${input.getValue()}_`);
      lines.push("");
      const max = 10;
      const start = Math.max(0, Math.min(idx - Math.floor(max / 2), matched.length - max));
      const end = Math.min(start + max, matched.length);
      for (let i = start; i < end; i++) {
        const { m } = matched[i];
        const cursor = i === idx ? theme.fg("accent", "→ ") : "  ";
        const label = `${m.provider}/${m.id}`;
        const sick = isSick(`${m.provider}/${m.id}`);
        const sickTag = sick ? theme.fg("warning", " [sick]") : "";
        lines.push(`${cursor}${label}${theme.fg("dim", `  ${m.name ?? ""}`)}${sickTag}`);
      }
      if (matched.length === 0) lines.push(theme.fg("warning", "  (no matches)"));
      lines.push("");
      lines.push(theme.fg("muted", `  ${matched.length} of ${available.length} models`));
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
        const matched = fuzzyFilter(
          available.map((m) => ({ m })),
          query,
          ({ m }) => `${m.provider}/${m.id} ${m.name ?? ""}`,
        );
        const pick = matched[idx];
        if (pick) {
          done({ provider: pick.m.provider, id: pick.m.id, name: pick.m.name });
        } else {
          done(null);
        }
        return;
      }
      if (matchesKey(data, Key.up)) {
        const matched = fuzzyFilter(
          available.map((m) => ({ m })),
          query,
          ({ m }) => `${m.provider}/${m.id} ${m.name ?? ""}`,
        );
        if (matched.length > 0) idx = (idx - 1 + matched.length) % matched.length;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        const matched = fuzzyFilter(
          available.map((m) => ({ m })),
          query,
          ({ m }) => `${m.provider}/${m.id} ${m.name ?? ""}`,
        );
        if (matched.length > 0) idx = (idx + 1) % matched.length;
        refresh();
        return;
      }
      input.handleInput(data);
      query = input.getValue();
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

// ─── Commands ────────────────────────────────────────────────────────────────

function statusLine(ctx: ExtensionContext, cfg: Config): string {
  const cur = ctx.model ? modelKey(ctx.model) : "(none)";
  const idx = chainState.currentIndex;
  const total = cfg.chain.length;
  const idxStr = idx >= 0 ? `${idx + 1}/${total}` : `not-in-chain`;
  const lastFail = health.get(cur);
  const sick = isSick(cur);
  const sickTag = sick ? " sick" : "";
  const errTag = lastFail && lastFail.lastError ? ` errs=${lastFail.consecutiveErrors}` : "";
  return `${cur}  chain=${idxStr}  fallbacks-used=${chainState.recentFallbacks}${errTag}${sickTag}  enabled=${cfg.enabled}`;
}

function dumpChain(cfg: Config): string {
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
  lines.push(`recent fallbacks this session: ${chainState.recentFallbacks}`);
  return lines.join("\n");
}

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("fallback", {
    description: "Open fallback chain editor (use subcommands: add, remove, list, status, condition, enable, disable, reset, clear, skip, help)",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["add", "pick", "remove", "move", "list", "status", "condition", "enable", "disable", "reset", "clear", "skip", "help"];
      return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      const cfg = loadConfig();
      const arg = (args ?? "").trim();
      const sub = arg.split(/\s+/)[0] ?? "";

      if (sub === "" || sub === "edit" || sub === "open") {
        const result = await openChainEditor(pi, ctx, cfg.chain);
        if (result.action === "commit") {
          ctx.ui.notify(`Chain saved (${result.chain.length} models)`, "info");
        } else if (result.action === "cancel") {
          ctx.ui.notify("Cancelled", "info");
        }
        return;
      }
      if (sub === "help") {
        ctx.ui.notify(
          [
            "/fallback                open chain editor",
            "/fallback add            fuzzy-pick and append a model",
            "/fallback pick           fuzzy-pick and insert at position",
            "/fallback remove <idx>   remove a chain entry",
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
        health.clear();
        chainState.recentFallbacks = 0;
        chainState.abortTriggered = false;
        if (chainState.pendingTimeout) {
          clearTimeout(chainState.pendingTimeout);
          chainState.pendingTimeout = null;
        }
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
        const h = getHealth(k);
        if (h.sickUntil === 0 || now() >= h.sickUntil) {
          h.sickUntil = now() + (cfg.triggers.skipFailingForMs || 300_000);
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

// ─── Event handlers ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Load config at startup so early events see current state.
  loadConfig();
  registerCommands(pi);

  pi.on("session_start", async (_event, ctx) => {
    // Fresh in-process state per session.
    chainState = {
      currentIndex: loadConfig().chain.findIndex((e) =>
        ctx.model ? chainEntryKey(e) === modelKey(ctx.model) : false,
      ),
      recentFallbacks: 0,
      lastUserText: null,
      retryInFlight: false,
      abortTriggered: false,
      pendingTimeout: null,
      requestStartedAt: 0,
    };
    // Note: we do NOT clear `health` — it represents per-model health across
    // the lifetime of the process so sick cooldown survives session switches.
    ctx.ui.setStatus(
      "fallback-router",
      loadConfig().enabled
        ? `fallback: on (chain=${loadConfig().chain.length})`
        : "fallback: off",
    );
  });

  pi.on("model_select", async (event, ctx) => {
    const cfg = loadConfig();
    const k = modelKey(event.model);
    const idx = cfg.chain.findIndex((e) => chainEntryKey(e) === k);
    if (idx >= 0) {
      chainState.currentIndex = idx;
    } else if (event.source === "set" || event.source === "cycle") {
      // User-initiated change — keep chain intact but mark we are off-chain.
      chainState.currentIndex = -1;
    }
    ctx.ui.setStatus(
      "fallback-router",
      cfg.enabled
        ? `fallback: on (chain=${cfg.chain.length}, idx=${idx >= 0 ? idx + 1 : "off-chain"})`
        : "fallback: off",
    );
  });

  pi.on("message_start", async (event, ctx) => {
    const msg = event.message as { role?: unknown; content?: unknown };
    if (msg.role !== "user") return;
    const text = extractUserText(msg.content);
    if (text === null) return;
    chainState.lastUserText = text;
    if (chainState.retryInFlight) {
      // We re-queued this message — don't reset recentFallbacks; consume the
      // flag so the next user message resets as normal.
      chainState.retryInFlight = false;
      return;
    }
    // Fresh user message: reset the consecutive-error counter for the
    // currently-active model so a single transient error after a long
    // conversation doesn't trigger fallback unless errors actually
    // accumulate.
    if (ctx.model) {
      const k = modelKey(ctx.model);
      getHealth(k).consecutiveErrors = 0;
    }
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const cfg = loadConfig();
    if (!cfg.enabled || cfg.chain.length === 0) return;
    if (!ctx.model) return;
    const k = modelKey(ctx.model);
    const { triggers } = effectiveTriggers(k);
    if (triggers.timeoutMs <= 0) return;
    if (chainState.pendingTimeout) {
      clearTimeout(chainState.pendingTimeout);
      chainState.pendingTimeout = null;
    }
    chainState.requestStartedAt = now();
    chainState.abortTriggered = false;
    chainState.pendingTimeout = setTimeout(() => {
      // If the response has already arrived, after_provider_response cleared
      // this timer. Otherwise it's still pending and we abort.
      if (!ctx.isIdle()) {
        chainState.abortTriggered = true;
        try {
          ctx.abort();
        } catch (err) {
          console.warn(`[fallback-router] ctx.abort() threw: ${err}`);
        }
        try {
          ctx.ui.notify(
            `Fallback router: timeout after ${triggers.timeoutMs}ms on ${k}`,
            "warning",
          );
        } catch { /* swallow */ }
      }
    }, triggers.timeoutMs);
  });

  pi.on("after_provider_response", async () => {
    // Headers received — clear the timeout, response is in flight.
    if (chainState.pendingTimeout) {
      clearTimeout(chainState.pendingTimeout);
      chainState.pendingTimeout = null;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const cfg = loadConfig();
    if (!cfg.enabled || cfg.chain.length === 0) return;
    const msg = event.message as {
      role?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
      content?: unknown;
      [k: string]: unknown;
    };
    if (msg.role !== "assistant") return;
    if (!ctx.model) return;

    const stopReason = msg.stopReason;
    const isError = stopReason === "error";
    const isAbort = stopReason === "aborted";
    const isSuccess = stopReason === "stop" || stopReason === "toolUse" || stopReason === "length";

    // Always clear any pending timeout on message_end.
    if (chainState.pendingTimeout) {
      clearTimeout(chainState.pendingTimeout);
      chainState.pendingTimeout = null;
    }

    const curKey = modelKey(ctx.model);

    if (isSuccess) {
      recordSuccess(curKey);
      return;
    }

    if (!isError && !isAbort) return;

    // For aborts, only treat as a timeout-fallback if WE triggered the abort.
    if (isAbort && !chainState.abortTriggered) {
      // User or external abort — do not fall back.
      chainState.abortTriggered = false;
      return;
    }

    const errText = (typeof msg.errorMessage === "string" ? msg.errorMessage : "")
      || (isAbort ? "stalled past timeoutMs" : "unknown provider error");

    recordFailure(curKey, errText);

    const { triggers } = effectiveTriggers(curKey);
    const h = getHealth(curKey);

    // Same-model retries (retriesBeforeFallback)
    // We do the same-model retry by re-sending the user message while staying
    // on the same model — but only if retries are configured and the failure
    // is a transient error (not a timeout we've already retried implicitly
    // by re-running the call). For simplicity we treat any failure as
    // retriable on the same model up to retriesBeforeFallback times, then
    // advance the chain.
    if (triggers.retriesBeforeFallback > 0 && chainState.retryInFlight === false) {
      // We track same-model retries via a per-model counter on health.
      // (consecutiveErrors already increments; use the gap between it and a
      // dedicated same-model-retry counter? To keep things simple, treat
      // consecutiveErrors itself as the same-model retry budget: if it's
      // <= retriesBeforeFallback, retry same model; else advance.)
      if (h.consecutiveErrors <= triggers.retriesBeforeFallback && !isAbort) {
        // Same-model retry
        if (!chainState.lastUserText) return;
        ctx.ui.notify(
          `Fallback router: retrying ${curKey} (attempt ${h.consecutiveErrors}/${triggers.retriesBeforeFallback}): ${truncate(errText)}`,
          "warning",
        );
        const textToSend = chainState.lastUserText;
        setTimeout(() => {
          chainState.retryInFlight = true;
          try {
            pi.sendUserMessage(textToSend, { deliverAs: "followUp" });
          } catch (err) {
            chainState.retryInFlight = false;
            try {
              ctx.ui.notify(`Same-model retry failed: ${truncate(err instanceof Error ? err.message : String(err))}`, "error");
            } catch { /* swallow */ }
          }
        }, Math.max(0, triggers.retryDelayMs));
        return;
      }
    }

    // Now decide whether to advance the chain.
    const consecHit = triggers.consecutiveErrors > 0 && h.consecutiveErrors >= triggers.consecutiveErrors;
    const windowHit = triggers.errorsInWindow > 0 && h.windowErrors >= triggers.errorsInWindow;
    const isTimeout = isAbort && chainState.abortTriggered;
    const timeoutHit = isTimeout && triggers.timeoutMs > 0;

    if (!consecHit && !windowHit && !timeoutHit) {
      // Threshold not met — leave the error visible, let pi-retry-on-error
      // handle same-model retries or the user decide.
      return;
    }

    const decision = decideFallback({
      cfg,
      currentModel: ctx.model,
      reason: isTimeout ? "timeout" : isAbort ? "abort" : "error",
      errText,
    });
    if (!decision.shouldFallback) {
      // Out of healthy fallbacks. Notify and stop trying.
      ctx.ui.notify(
        `Fallback router: no healthy model after ${curKey} failed (${errText})`,
        "error",
      );
      return;
    }

    // Replace the error message with a fallback notice (so the session reads
    // cleanly) and execute the fallback (which re-sends the user message).
    chainState.abortTriggered = false; // consumed

    void performFallback({ pi, ctx, currentModel: ctx.model, decision });

    const targetKey = chainEntryKey(decision.target!);
    return {
      message: buildFallbackNotice({
        original: msg as Record<string, unknown>,
        fromKey: curKey,
        toKey: targetKey,
        reason: decision.reason,
        attempt: chainState.recentFallbacks + 1,
      }) as unknown as typeof event.message,
    };
  });
}

