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
 *     and rolling-window error rate. Each trigger can be tuned independently.
 *   • A /model-like fuzzy selector for picking fallback models.
 *   • Per-model "sick" cooldown so a flaky model is skipped for a while after
 *     it fails (configurable per-trigger via `skipFailingForMs`).
 *   • Optional bounded retries per fall-through so a single transient hiccup
 *     does not burn the whole chain.
 *   • Persistent JSON config in ~/.pi/agent/fallback-router.json (chain +
 *     triggers + per-model overrides) plus a runtime health/state cache.
 *
 * What this is NOT:
 *   • It is not a global retry-on-error. pi-retry-on-error already retries the
 *     same model transparently; this router only swaps models when retries
 *     would just keep hitting the same broken upstream.
 *   • It does not silently change user-selected models. Switching happens only
 *     in response to a failure trigger on the current model.
 *
 * Commands: see src/commands.ts (`/fallback`, `/fallback add`, etc.)
 * Config:   see src/config.ts (`~/.pi/agent/fallback-router.json`)
 * Health:   see src/health.ts (per-model counters + sick cooldown)
 * UI:       see src/ui.ts (chain editor, condition editor, model picker)
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
 *     path.
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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

import { loadConfig } from "./src/config.js";
import { registerCommands } from "./src/commands.js";
import {
  chainEntryKey,
  clearHealth,
  decideFallback,
  effectiveTriggers,
  getHealth,
  getHealthMap,
  isSick,
  modelKey,
  recordFailure,
  recordSuccess,
} from "./src/health.js";

// ─── Runtime state ───────────────────────────────────────────────────────────

interface ChainState {
  currentIndex: number;
  recentFallbacks: number;
  lastUserText: string | null;
  retryInFlight: boolean;
  abortTriggered: boolean;
  pendingTimeout: ReturnType<typeof setTimeout> | null;
  requestStartedAt: number;
}

let chainState: ChainState = {
  currentIndex: -1,
  recentFallbacks: 0,
  lastUserText: null,
  retryInFlight: false,
  abortTriggered: false,
  pendingTimeout: null,
  requestStartedAt: 0,
};

// ─── Small helpers ───────────────────────────────────────────────────────────

function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
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

function findModelInRegistry(
  ctx: { modelRegistry: { find: (provider: string, id: string) => unknown } },
  provider: string,
  id: string,
) {
  return ctx.modelRegistry.find(provider, id);
}

// ─── Fallback execution ─────────────────────────────────────────────────────

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
  ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void }; modelRegistry: { find: (p: string, i: string) => { provider: string; id: string; name?: string } | undefined }; model: { provider: string; id: string } };
  currentModel: { provider: string; id: string };
  decision: { reason: string; target: { provider: string; id: string; name?: string } };
}): Promise<void> {
  const { pi, ctx, currentModel, decision } = opts;
  const cfg = loadConfig();
  const target = decision.target;
  const targetModel = findModelInRegistry(ctx, target.provider, target.id) as
    | { provider: string; id: string }
    | undefined;
  if (!targetModel) {
    ctx.ui.notify(
      `Fallback router: ${chainEntryKey(target)} not available in registry`,
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
  if (!chainState.lastUserText) {
    ctx.ui.notify(
      `Fallback router: cannot requeue (no user text captured) — staying on ${modelKey(currentModel)}`,
      "error",
    );
    return;
  }

  const success = await pi.setModel(targetModel as unknown as Model<unknown>);
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

// ─── Default export ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Load config at startup so early events see current state.
  loadConfig();
  registerCommands(pi, {
    get currentIndex() { return chainState.currentIndex; },
    get recentFallbacks() { return chainState.recentFallbacks; },
    sickKeys: () => getHealthMap().keys(),
    clearAll: () => {
      clearHealth();
      chainState.recentFallbacks = 0;
      chainState.abortTriggered = false;
      if (chainState.pendingTimeout) {
        clearTimeout(chainState.pendingTimeout);
        chainState.pendingTimeout = null;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
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
    // Note: we do NOT clear `health` — sick cooldown survives session switches.
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
      // We re-queued this message — consume the flag so the next user
      // message resets as normal.
      chainState.retryInFlight = false;
      return;
    }
    if (ctx.model) {
      const k = modelKey(ctx.model);
      getHealth(k).consecutiveErrors = 0;
    }
  });

  pi.on("before_provider_request", async (_event, ctx) => {
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
    chainState.requestStartedAt = Date.now();
    chainState.abortTriggered = false;
    chainState.pendingTimeout = setTimeout(() => {
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
    if (chainState.pendingTimeout) {
      clearTimeout(chainState.pendingTimeout);
      chainState.pendingTimeout = null;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const cfg = loadConfig();
    if (!cfg.enabled || cfg.chain.length === 0) return;
    const msg = event.message as unknown as {
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

    // Only treat as a fallback-eligible abort if WE triggered the abort.
    if (isAbort && !chainState.abortTriggered) {
      chainState.abortTriggered = false;
      return;
    }

    const errText = (typeof msg.errorMessage === "string" ? msg.errorMessage : "")
      || (isAbort ? "stalled past timeoutMs" : "unknown provider error");

    recordFailure(curKey, errText);

    const { triggers } = effectiveTriggers(curKey);
    const h = getHealth(curKey);

    // Same-model retries (retriesBeforeFallback)
    if (triggers.retriesBeforeFallback > 0 &&
        chainState.retryInFlight === false &&
        h.consecutiveErrors <= triggers.retriesBeforeFallback &&
        !isAbort) {
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

    const consecHit = triggers.consecutiveErrors > 0 && h.consecutiveErrors >= triggers.consecutiveErrors;
    const windowHit = triggers.errorsInWindow > 0 && h.windowErrors >= triggers.errorsInWindow;
    const isTimeout = isAbort && chainState.abortTriggered;
    const timeoutHit = isTimeout && triggers.timeoutMs > 0;

    if (!consecHit && !windowHit && !timeoutHit) {
      return;
    }

    const decision = decideFallback({
      cfg,
      currentModel: ctx.model,
      reason: isTimeout ? "timeout" : isAbort ? "abort" : "error",
      errText,
    });
    if (!decision.shouldFallback || !decision.target) {
      ctx.ui.notify(
        `Fallback router: no healthy model after ${curKey} failed (${truncate(errText)})`,
        "error",
      );
      return;
    }

    chainState.abortTriggered = false; // consumed

    void performFallback({
      pi,
      ctx: ctx as unknown as Parameters<typeof performFallback>[0]["ctx"],
      currentModel: ctx.model,
      decision: { reason: decision.reason, target: decision.target },
    });

    const targetKey = chainEntryKey(decision.target);
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