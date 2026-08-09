/**
 * Per-model health tracking and fallback-decision logic.
 *
 * `health` is a Map<string, ModelHealth> where the key is "provider/id".
 * Each entry tracks consecutive errors, a rolling-window error count, and a
 * "sickUntil" timestamp so a flaky model is skipped for a while after it fails.
 *
 * `effectiveTriggers()` merges global triggers with per-model overrides at
 * decision time (so a slow model can get a longer timeoutMs without changing
 * the global setting).
 *
 * `decideFallback()` is the pure-logic core of the router. Given the current
 * model, the failure reason, and a known config, it returns:
 *   • shouldFallback: should we switch to a different chain entry?
 *   • reason:         copy for notifications
 *   • target:         the chain entry to switch to (if any)
 *
 * Caller (`performFallback` in index.ts) handles side effects: switching the
 * model, replacing the error message in the session, and re-sending the
 * user's last text via followUp.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ChainEntry, Config, PerModelOverrides, Triggers } from "./config.js";
import { loadConfig } from "./config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ModelHealth {
  consecutiveErrors: number;
  windowErrors: number;
  windowStart: number;
  sickUntil: number;
  lastError?: string;
  lastErrorAt?: number;
}

const health: Map<string, ModelHealth> = new Map();

export function getHealthMap(): Map<string, ModelHealth> {
  return health;
}

export function clearHealth(): void {
  health.clear();
}

export function modelKey(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`;
}

export function chainEntryKey(e: ChainEntry): string {
  return `${e.provider}/${e.id}`;
}

export function getHealth(key: string): ModelHealth {
  let h = health.get(key);
  if (!h) {
    h = {
      consecutiveErrors: 0,
      windowErrors: 0,
      windowStart: Date.now(),
      sickUntil: 0,
    };
    health.set(key, h);
  }
  return h;
}

export function resetHealthCounter(key: string): void {
  const h = getHealth(key);
  h.consecutiveErrors = 0;
  h.windowErrors = 0;
  h.windowStart = Date.now();
}

export function recordSuccess(key: string): void {
  resetHealthCounter(key);
  getHealth(key).sickUntil = 0;
}

export function recordFailure(key: string, errText: string): void {
  const h = getHealth(key);
  const t = Date.now();
  const cfg = loadConfig();
  if (t - h.windowStart > cfg.triggers.windowMs) {
    h.windowStart = t;
    h.windowErrors = 0;
  }
  h.consecutiveErrors += 1;
  h.windowErrors += 1;
  h.lastError = errText.slice(0, 240);
  h.lastErrorAt = t;
  const override = cfg.perModel?.[key]?.skipFailingForMs;
  const skipMs = override ?? cfg.triggers.skipFailingForMs;
  if (skipMs > 0) h.sickUntil = t + skipMs;
}

export function isSick(key: string): boolean {
  const h = getHealth(key);
  if (h.sickUntil === 0) return false;
  if (Date.now() >= h.sickUntil) {
    h.sickUntil = 0;
    return false;
  }
  return true;
}

/**
 * Merge per-model overrides on top of the global triggers for a specific
 * model. Used at decision time so the timeout/consecutive-error thresholds
 * can be tuned per model without touching the global defaults.
 */
export function effectiveTriggers(modelKeyStr: string): {
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

// ─── Decision ───────────────────────────────────────────────────────────────

export interface FallbackDecision {
  shouldFallback: boolean;
  reason: string;
  target: ChainEntry | undefined;
  /** index in config.chain of the model that just failed (for notification copy) */
  fromIndex: number;
}

export function decideFallback(opts: {
  cfg: Config;
  currentModel: Model;
  reason: "error" | "timeout" | "abort";
  errText: string;
}): FallbackDecision {
  const { cfg, currentModel, reason, errText } = opts;
  const curKey = modelKey(currentModel);
  const curIndex = cfg.chain.findIndex((e) => chainEntryKey(e) === curKey);
  const fromIndex = curIndex;

  // If the current model is not in the chain, user picked it manually —
  // search the chain from the beginning so a user-picked model still has
  // somewhere to fall back to.
  const searchFrom = curIndex === -1 ? 0 : curIndex + 1;

  const reasonText = reason === "timeout"
    ? `timeout (${errText || "no progress"})`
    : reason === "abort"
      ? "aborted"
      : `error: ${errText.slice(0, 120)}`;

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