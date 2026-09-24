/**
 * Soft global compaction boundary for Pi.
 *
 * This extension never edits model metadata or provider payloads. At an idle
 * task boundary it asks Pi to run its normal compactor when usage reaches the
 * first configured boundary: the absolute token cap or a percentage of the
 * selected model's native context window. Pi remains responsible for the cut
 * point, summarization, persistence, and retries.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_ABSOLUTE_TOKEN_LIMIT = 200_000;
export const DEFAULT_CONTEXT_PERCENT = 80;
export const DEFAULT_COOLDOWN_MS = 30_000;
export const DEFAULT_HYSTERESIS_TOKENS = 8_000;
export const MIN_CONTEXT_PERCENT = 50;
export const MAX_CONTEXT_PERCENT = 95;

export interface SoftCompactionSettings {
  absoluteTokenLimit: number;
  contextPercent: number;
  cooldownMs: number;
  hysteresisTokens: number;
}

export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: "disabled" | "busy" | "compacting" | "pending" | "cooldown" | "hysteresis" | "below-threshold" | "threshold" | "absolute-cap";
  thresholdTokens: number;
  usageTokens: number | null;
  contextWindow: number;
}

type JsonRecord = Record<string, unknown>;

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function boundedPercent(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_CONTEXT_PERCENT, Math.max(MIN_CONTEXT_PERCENT, value));
}

export function readSoftCompactionSettings(path = getSettingsPath()): SoftCompactionSettings {
  let settings: JsonRecord = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(parsed)) settings = parsed;
    } catch {
      // A malformed settings file must not break session startup. Pi owns the
      // error surface for its own settings; this extension uses safe defaults.
    }
  }

  return {
    absoluteTokenLimit: positiveInteger(settings.globalContextLimit) ?? DEFAULT_ABSOLUTE_TOKEN_LIMIT,
    contextPercent: boundedPercent(settings.globalContextCompactionPercent, DEFAULT_CONTEXT_PERCENT),
    cooldownMs: nonNegativeInteger(settings.globalContextCompactionCooldownMs) ?? DEFAULT_COOLDOWN_MS,
    hysteresisTokens: nonNegativeInteger(settings.globalContextCompactionHysteresisTokens) ?? DEFAULT_HYSTERESIS_TOKENS,
  };
}

export function compactionThresholdTokens(
  contextWindow: number,
  settings: Pick<SoftCompactionSettings, "absoluteTokenLimit" | "contextPercent">,
): number {
  const native = positiveInteger(contextWindow);
  const percentThreshold = native === undefined
    ? Number.POSITIVE_INFINITY
    : Math.floor(native * settings.contextPercent / 100);
  return Math.max(1, Math.min(settings.absoluteTokenLimit, percentThreshold));
}

export function decideCompaction(options: {
  enabled: boolean;
  usage: ContextUsageLike | undefined;
  settings: SoftCompactionSettings;
  idle: boolean;
  compacting: boolean;
  lastCompactionAt: number;
  now: number;
  requestPending?: boolean;
}): CompactionDecision {
  const usage = options.usage;
  const contextWindow = positiveInteger(usage?.contextWindow) ?? 0;
  const usageTokens = positiveInteger(usage?.tokens) ?? null;
  const thresholdTokens = compactionThresholdTokens(contextWindow, options.settings);
  const base = { thresholdTokens, usageTokens, contextWindow };
  if (!options.enabled) return { ...base, shouldCompact: false, reason: "disabled" };
  if (!options.idle) return { ...base, shouldCompact: false, reason: "busy" };
  if (options.compacting) return { ...base, shouldCompact: false, reason: "compacting" };
  if (options.requestPending) return { ...base, shouldCompact: false, reason: "pending" };
  if (usageTokens === null) return { ...base, shouldCompact: false, reason: "below-threshold" };
  if (options.now - options.lastCompactionAt < options.settings.cooldownMs) {
    return { ...base, shouldCompact: false, reason: "cooldown" };
  }
  if (usageTokens < thresholdTokens) return { ...base, shouldCompact: false, reason: "below-threshold" };
  if (usageTokens < thresholdTokens + options.settings.hysteresisTokens) {
    return { ...base, shouldCompact: false, reason: "hysteresis" };
  }
  return {
    ...base,
    shouldCompact: true,
    reason: thresholdTokens === options.settings.absoluteTokenLimit ? "absolute-cap" : "threshold",
  };
}

interface CoordinatorContext extends ExtensionContext {
  isCompacting?: boolean;
}

type CompactFailureAwarePi = ExtensionAPI & {
  on(
    event: "session_compact_failed",
    handler: (event: { aborted?: boolean; willRetry?: boolean }, ctx: ExtensionContext) => Promise<void>,
  ): void;
};

export default function globalContextLimitExtension(pi: ExtensionAPI): void {
  let enabled = true;
  let settings = readSoftCompactionSettings();
  let lastCompactionAt = 0;
  let requestPending = false;
  let notifiedThisSession = false;

  const refreshSettings = (): void => {
    settings = readSoftCompactionSettings();
  };

  const evaluate = (ctx: CoordinatorContext): CompactionDecision => decideCompaction({
    enabled,
    usage: ctx.getContextUsage(),
    settings,
    idle: ctx.isIdle(),
    compacting: ctx.isCompacting === true,
    lastCompactionAt,
    now: Date.now(),
    requestPending,
  });

  const requestCompactionIfDue = (ctx: CoordinatorContext): void => {
    if (!enabled) return;
    const decision = evaluate(ctx);
    if (!decision.shouldCompact) return;

    // ctx.compact() is Pi's public non-awaited compaction entry point. Mark
    // the request synchronously so another lifecycle event in the same turn
    // cannot enqueue a duplicate before Pi flips isCompacting.
    requestPending = true;
    lastCompactionAt = Date.now();
    ctx.ui.notify(
      `Soft context boundary reached (${decision.usageTokens?.toLocaleString()} / ${decision.thresholdTokens.toLocaleString()} tokens); asking Pi to compact.`,
      "info",
    );
    try {
      ctx.compact();
    } catch (error) {
      requestPending = false;
      ctx.ui.notify(`Soft compaction request failed: ${(error as Error).message}`, "warning");
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshSettings();
    enabled = settings.absoluteTokenLimit > 0;
    requestPending = false;
    notifiedThisSession = false;
    if (enabled && !notifiedThisSession) {
      notifiedThisSession = true;
      const threshold = compactionThresholdTokens(ctx.model?.contextWindow ?? 0, settings);
      ctx.ui.notify(
        `Soft compaction boundary: ${threshold.toLocaleString()} tokens (${settings.contextPercent}% or ${settings.absoluteTokenLimit.toLocaleString()}, whichever comes first). Model limits are unchanged.`,
        "info",
      );
    }
  });

  // Input marks a real user request. Never start coordinator compaction while
  // that request is entering the host; Pi's own threshold/overflow path owns it.
  pi.on("input", async () => {
    requestPending = false;
  });

  // agent_settled is the notification-only idle boundary. Calling Pi's public
  // compact() there cannot interrupt a model/tool turn or race its own retry.
  pi.on("agent_settled", async (_event, ctx) => {
    refreshSettings();
    requestCompactionIfDue(ctx as CoordinatorContext);
  });

  // A successful manual, threshold, or overflow compaction is authoritative and
  // resets both cooldown and duplicate-request state.
  pi.on("session_compact", async (_event, _ctx) => {
    requestPending = false;
    lastCompactionAt = Date.now();
  });

  (pi as CompactFailureAwarePi).on("session_compact_failed", async (_event, _ctx) => {
    requestPending = false;
  });

  pi.registerCommand("context-limit", {
    description: "Show or configure the soft global compaction boundary",
    handler: async (args, commandCtx) => {
      refreshSettings();
      const value = args.trim();
      if (!value) {
        const threshold = compactionThresholdTokens(commandCtx.model?.contextWindow ?? 0, settings);
        commandCtx.ui.notify(
          `Soft compaction boundary: ${threshold.toLocaleString()} tokens (${settings.contextPercent}% or ${settings.absoluteTokenLimit.toLocaleString()}, whichever comes first). Model limits are unchanged.`,
          "info",
        );
        return;
      }
      if (value === "off" || value === "clear") {
        enabled = false;
        requestPending = false;
        commandCtx.ui.notify("Soft global compaction coordinator disabled for this session; model limits remain unchanged.", "info");
        return;
      }
      if (value === "on" || value === "rebuild") {
        enabled = true;
        requestPending = false;
        requestCompactionIfDue(commandCtx as CoordinatorContext);
        commandCtx.ui.notify("Soft global compaction coordinator enabled; model limits remain unchanged.", "info");
        return;
      }
      commandCtx.ui.notify(
        "Use /context-limit on, /context-limit off, or configure globalContextLimit and globalContextCompactionPercent in settings.json. This extension never changes model limits.",
        "info",
      );
    },
  });
}
