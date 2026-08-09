/**
 * Configuration types, defaults, load/save, and validation for the
 * auto-fallback-router extension.
 *
 * The on-disk format lives at ~/.pi/agent/fallback-router.json and is a single
 * JSON object with three top-level fields:
 *   • version (currently always 1)
 *   • enabled (boolean)
 *   • chain (array of {provider, id, name?})
 *   • triggers (per-request timeout + retry/error thresholds)
 *   • perModel (optional overrides keyed by "provider/id")
 *
 * Unknown fields are tolerated but ignored. Malformed files fall back to
 * defaults with a console warning so a typo never bricks the extension.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChainEntry {
  provider: string;
  id: string;
  name?: string;
}

export interface Triggers {
  /** Abort a request that stalls longer than this with no progress (0 = off). */
  timeoutMs: number;
  /** N consecutive errors on the SAME model → next chain entry (0 = off). */
  consecutiveErrors: number;
  /** N errors within windowMs on the SAME model → next chain entry (0 = off). */
  errorsInWindow: number;
  /** Rolling window for `errorsInWindow`. */
  windowMs: number;
  /** Same-model retries before falling through to the next chain entry. */
  retriesBeforeFallback: number;
  /** Delay between same-model retries (ms). */
  retryDelayMs: number;
  /** Safety cap on auto-fallbacks per session (0 = unlimited). */
  maxFallbacksPerSession: number;
  /** Mark a model "sick" for this long after it fails (0 = off). */
  skipFailingForMs: number;
  /** When a sick model's cooldown elapses, auto-revert to it if it is upstream in the chain. */
  promoteWhenHealthy: boolean;
}

export interface PerModelOverrides {
  timeoutMs?: number;
  consecutiveErrors?: number;
  errorsInWindow?: number;
  skipFailingForMs?: number;
  retriesBeforeFallback?: number;
  retryDelayMs?: number;
}

export interface Config {
  version: 1;
  enabled: boolean;
  chain: ChainEntry[];
  triggers: Triggers;
  perModel?: Record<string, PerModelOverrides>;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_TRIGGERS: Triggers = {
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

export const DEFAULT_CONFIG: Config = {
  version: 1,
  enabled: true,
  chain: [],
  triggers: { ...DEFAULT_TRIGGERS },
};

export const CONFIG_PATH: string = join(getAgentDir(), "fallback-router.json");

// ─── Validation (defensive — never throw on bad input) ──────────────────────

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

// ─── Persistence ────────────────────────────────────────────────────────────

let writeChain: Promise<void> = Promise.resolve();
let cachedConfig: Config | null = null;

export function loadConfig(): Config {
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

export function saveConfig(cfg: Config): void {
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