/**
 * pi-retry-on-error
 *
 * Automatically re-sends the last user message whenever a provider finishes
 * with an assistant message whose stopReason is "error". The default policy is
 * intentionally endless: retries continue until the request succeeds, the
 * user starts another prompt, the user runs `/retry stop`, or the session is
 * shut down.
 *
 * This is provider-agnostic. It does not try to classify errors, so HTTP
 * errors, gateway errors, timeouts, connection failures, and provider-specific
 * errors all follow the same policy. Retries use exponential backoff so an
 * outage does not turn into a tight request loop.
 *
 * Safety boundaries:
 *   - User cancellations (`stopReason: "aborted"`) are never retried.
 *   - Tool-result errors are not replayed automatically. Re-running an entire
 *     prompt after a failed write/bash/tool call could repeat side effects.
 *   - `/retry stop` cancels a pending retry immediately.
 *   - `PI_RETRY_MAX_RETRIES` and `PI_RETRY_MAX_DURATION_MS` can impose hard
 *     bounds when endless retries are not appropriate.
 *
 * The extension keeps the original user content (including image blocks) and
 * uses `deliverAs: "followUp"`, which is safe while another turn is finishing.
 * Retry notices preserve every field on the original assistant message because
 * pi replaces messages in place and downstream usage/context code expects those
 * fields to remain present.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Configuration ────────────────────────────────────────────────────────────

const MIN_RETRY_DELAY_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const STATUS_KEY = "pi-retry-on-error";
const RETRY_NOTICE_MARKER = "[pi-retry-on-error]";

type RetryableUserContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_TIMER_DELAY_MS);
}

function readRetryLimitEnv(): number {
  const raw = process.env.PI_RETRY_MAX_RETRIES?.trim().toLowerCase();
  if (!raw || raw === "unlimited" || raw === "infinite" || raw === "inf") {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
}

function readBackoffMultiplierEnv(): number {
  const raw = process.env.PI_RETRY_BACKOFF_MULTIPLIER?.trim();
  if (!raw) return 2;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 2;
  return Math.min(parsed, 100);
}

const MAX_RETRIES = readRetryLimitEnv();
const RETRY_DELAY_MS = Math.max(
  MIN_RETRY_DELAY_MS,
  readNonNegativeIntEnv("PI_RETRY_DELAY_MS", 5_000),
);
const RETRY_BACKOFF_MULTIPLIER = readBackoffMultiplierEnv();
const RETRY_MAX_DELAY_MS = Math.max(
  RETRY_DELAY_MS,
  readNonNegativeIntEnv("PI_RETRY_MAX_DELAY_MS", 60_000),
);
// `0` means no time limit. This is separate from max retries so a session can
// be configured for, for example, 24 hours of retries without counting attempts.
const RETRY_MAX_DURATION_MS = readNonNegativeIntEnv("PI_RETRY_MAX_DURATION_MS", 0);
const RETRY_NOTIFY_EVERY = Math.max(
  1,
  readNonNegativeIntEnv("PI_RETRY_NOTIFY_EVERY", 5),
);
const RETRIES_CONFIGURED = MAX_RETRIES !== 0;

// ─── Types and pure helpers ───────────────────────────────────────────────────

interface AssistantLike {
  role: "assistant";
  content: unknown;
  stopReason: string;
  errorMessage?: unknown;
  [key: string]: unknown;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

function cloneUserContent(content: unknown): RetryableUserContent | null {
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }

  if (!Array.isArray(content) || content.length === 0) return null;

  // Keep the complete text/image payload. Image-only prompts are valid and
  // should be retried too; unsupported blocks are skipped rather than sent
  // with a malformed shape.
  for (const block of content) {
    if (!block || typeof block !== "object") return null;
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "text" && typeof typedBlock.text !== "string") return null;
    if (typedBlock.type !== "text" && typedBlock.type !== "image") return null;
  }

  try {
    // User content is made of JSON-shaped text/image blocks. A structured copy
    // prevents a later event from mutating the content that will be retried.
    return structuredClone(content) as RetryableUserContent;
  } catch {
    // Older runtimes or unusual host objects can make structuredClone fail.
    // The supported block fields are value-like, so a shallow block copy is a
    // safe fallback for pi's TextContent/ImageContent shapes.
    return content.map((block) => ({ ...(block as Record<string, unknown>) })) as RetryableUserContent;
  }
}

function contentFingerprint(content: unknown): string {
  try {
    return JSON.stringify(content) ?? String(content);
  } catch {
    return String(content);
  }
}

function sameContent(first: unknown, second: unknown): boolean {
  return contentFingerprint(first) === contentFingerprint(second);
}

function truncateForNotice(text: string, max = 240): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function isAssistantError(message: MessageLike): boolean {
  return message.role === "assistant" && message.stopReason === "error";
}

function isAssistantTerminal(message: MessageLike): boolean {
  return message.role === "assistant" && message.stopReason !== "error";
}

function isRetryNotice(message: MessageLike): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;

  return message.content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const typedBlock = block as { type?: unknown; text?: unknown };
    return typedBlock.type === "text" &&
      typeof typedBlock.text === "string" &&
      typedBlock.text.startsWith(RETRY_NOTICE_MARKER);
  });
}

function formatRetryLimit(): string {
  return Number.isFinite(MAX_RETRIES) ? String(MAX_RETRIES) : "unlimited";
}

function formatDelay(delayMs: number): string {
  if (delayMs < 1_000) return `${delayMs}ms`;
  if (delayMs < 60_000) return `${Math.round(delayMs / 1_000)}s`;

  const minutes = delayMs / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function calculateRetryDelay(attempt: number): number {
  // Cap the exponent before Math.pow can overflow for an extremely long
  // outage. The outer cap is still the source of truth.
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const uncapped = RETRY_DELAY_MS * Math.pow(RETRY_BACKOFF_MULTIPLIER, exponent);
  if (!Number.isFinite(uncapped)) return RETRY_MAX_DELAY_MS;
  return Math.min(RETRY_MAX_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, Math.round(uncapped)));
}

function buildRetryNotice(
  original: AssistantLike,
  errorText: string,
  attempt: number,
): AssistantLike {
  const safeError = truncateForNotice(errorText || "unknown provider error");
  const attemptLabel = Number.isFinite(MAX_RETRIES)
    ? `${attempt}/${MAX_RETRIES}`
    : `${attempt} (continuous)`;

  return {
    // The runner replaces the original object in place and removes keys that
    // are absent from the replacement. Keep all original fields, including
    // api/provider/model/usage/timestamp, before changing the display fields.
    ...original,
    role: "assistant",
    stopReason: "stop",
    content: [
      {
        type: "text",
        text:
          `${RETRY_NOTICE_MARKER} Provider returned an error: ${safeError}\n\n` +
          `Retrying automatically (attempt ${attemptLabel})…`,
      },
    ],
    errorMessage: undefined,
  };
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // All state is factory-local. A reload or session replacement gets a fresh
  // state object and the old timer is cancelled by session_shutdown.
  let lastUserContent: RetryableUserContent | null = null;
  let retryCount = 0;
  let chainStartedAt: number | null = null;
  let lastErrorText: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryGeneration = 0;
  let retryDispatchPending = false;
  let retryMessageStarting = false;
  let expectedRetryFingerprint: string | null = null;
  let retryContextActive = false;
  let enabled = RETRIES_CONFIGURED;

  function safeNotify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
    try {
      ctx.ui.notify(message, type);
    } catch {
      // UI failures must never turn a provider error into an extension error.
    }
  }

  function safeSetStatus(ctx: ExtensionContext, text: string | undefined): void {
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // Status rendering is best-effort.
    }
  }

  function cancelScheduledRetry(): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    retryGeneration += 1;
    retryDispatchPending = false;
    retryMessageStarting = false;
    expectedRetryFingerprint = null;
  }

  function resetRetryState(ctx?: ExtensionContext): void {
    cancelScheduledRetry();
    lastUserContent = null;
    retryCount = 0;
    chainStartedAt = null;
    lastErrorText = null;
    retryContextActive = false;
    if (ctx) safeSetStatus(ctx, undefined);
  }

  function durationRemaining(now: number): number | undefined {
    if (RETRY_MAX_DURATION_MS === 0 || chainStartedAt === null) return undefined;
    return RETRY_MAX_DURATION_MS - (now - chainStartedAt);
  }

  function finishForDuration(ctx: ExtensionContext): void {
    safeNotify(
      ctx,
      `Retry window expired after ${formatDelay(RETRY_MAX_DURATION_MS)}${lastErrorText ? `: ${truncateForNotice(lastErrorText)}` : ""}`,
      "error",
    );
    resetRetryState(ctx);
  }

  function scheduleRetry(
    content: RetryableUserContent,
    delayMs: number,
    ctx: ExtensionContext,
  ): void {
    const generation = retryGeneration;
    retryTimer = setTimeout(() => {
      if (generation !== retryGeneration || !enabled) return;
      retryTimer = undefined;

      const remaining = durationRemaining(Date.now());
      if (remaining !== undefined && remaining <= 0) {
        finishForDuration(ctx);
        return;
      }

      retryDispatchPending = true;
      expectedRetryFingerprint = contentFingerprint(content);
      safeSetStatus(ctx, `retrying attempt ${retryCount} (${formatDelay(delayMs)} delay)`);

      try {
        // followUp works both while the agent is still finishing and when it
        // has become idle. It avoids the streaming-mode throw from omitting
        // deliverAs.
        pi.sendUserMessage(content, { deliverAs: "followUp" });
      } catch (err) {
        retryDispatchPending = false;
        retryMessageStarting = false;
        expectedRetryFingerprint = null;
        const message = err instanceof Error ? err.message : String(err);
        safeNotify(ctx, `Retry dispatch failed: ${truncateForNotice(message)}`, "error");

        // A local dispatch failure is not a provider attempt. Keep the same
        // attempt number and keep trying, subject to the same time window.
        const nextRemaining = durationRemaining(Date.now());
        if (nextRemaining !== undefined && nextRemaining <= 0) {
          finishForDuration(ctx);
          return;
        }
        const nextDelay = Math.min(
          calculateRetryDelay(Math.max(retryCount, 1)),
          nextRemaining ?? calculateRetryDelay(Math.max(retryCount, 1)),
        );
        scheduleRetry(content, Math.max(MIN_RETRY_DELAY_MS, nextDelay), ctx);
      }
    }, delayMs);
  }

  // Capture actual user content and distinguish it from the user message that
  // this extension is about to inject. The input event normally arrives first;
  // message_start also checks the flag so this remains safe if the host emits
  // the two events in a different order.
  pi.on("input", (event) => {
    if (event.source === "extension" && retryDispatchPending) {
      retryDispatchPending = false;
      retryMessageStarting = true;
      return;
    }

    if (event.source !== "extension") {
      // A new prompt supersedes an old pending retry. In particular, never let
      // a timer for yesterday's prompt fire after the user has moved on.
      resetRetryState();
    }
  });

  pi.on("message_start", (event, ctx) => {
    const message = event.message as MessageLike;
    if (message.role !== "user") return;

    const content = cloneUserContent(message.content);
    const pendingAutoRetry = retryDispatchPending || retryMessageStarting;
    const isAutoRetry = pendingAutoRetry &&
      (content === null || expectedRetryFingerprint === null || contentFingerprint(content) === expectedRetryFingerprint);

    retryDispatchPending = false;
    retryMessageStarting = false;
    expectedRetryFingerprint = null;

    if (content === null) {
      if (!isAutoRetry) resetRetryState(ctx);
      return;
    }

    lastUserContent = content;
    if (!isAutoRetry) {
      // Covers RPC callers and hosts that do not emit input before
      // message_start.
      cancelScheduledRetry();
      retryCount = 0;
      chainStartedAt = null;
      lastErrorText = null;
      retryContextActive = false;
      safeSetStatus(ctx, undefined);
    }
  });

  // Endless retries would otherwise append the same user message and notice
  // forever to the provider context. Hide only this extension's consecutive
  // retry pairs from the next request while retaining the original prompt.
  // The session transcript still keeps the notices for auditability.
  pi.on("context", (event) => {
    if (!retryContextActive || lastUserContent === null) return;

    const filtered: typeof event.messages = [];
    let afterRetryNotice = false;

    for (const message of event.messages) {
      if (isRetryNotice(message as MessageLike)) {
        afterRetryNotice = true;
        continue;
      }

      if (
        afterRetryNotice &&
        message.role === "user" &&
        sameContent(message.content, lastUserContent)
      ) {
        afterRetryNotice = false;
        continue;
      }

      afterRetryNotice = false;
      filtered.push(message);
    }

    if (filtered.length !== event.messages.length) {
      return { messages: filtered };
    }
  });

  // Any terminal assistant result, including an explicit user abort, ends the
  // retry chain. Only stopReason === "error" reaches the retry handler below.
  pi.on("message_end", (event, ctx) => {
    if (isAssistantTerminal(event.message as MessageLike)) {
      resetRetryState(ctx);
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as MessageLike;
    if (!isAssistantError(message)) return;

    const errorText = typeof message.errorMessage === "string"
      ? message.errorMessage
      : "unknown provider error";

    if (!enabled) {
      safeNotify(ctx, `Provider error (automatic retries are off): ${truncateForNotice(errorText)}`, "error");
      resetRetryState(ctx);
      return;
    }

    if (lastUserContent === null) {
      safeNotify(
        ctx,
        `Provider error (no user content captured to retry): ${truncateForNotice(errorText)}`,
        "error",
      );
      resetRetryState(ctx);
      return;
    }

    const now = Date.now();
    if (chainStartedAt === null) chainStartedAt = now;

    const remaining = durationRemaining(now);
    if (remaining !== undefined && remaining <= 0) {
      lastErrorText = errorText;
      finishForDuration(ctx);
      return;
    }

    // A finalized assistant error should only produce one timer. This guard
    // protects against duplicate host events and re-entrant providers.
    if (retryTimer !== undefined || retryDispatchPending || retryMessageStarting) return;

    if (Number.isFinite(MAX_RETRIES) && retryCount >= MAX_RETRIES) {
      safeNotify(
        ctx,
        `Provider error after ${MAX_RETRIES} ${MAX_RETRIES === 1 ? "retry" : "retries"}: ${truncateForNotice(errorText)}`,
        "error",
      );
      resetRetryState(ctx);
      return;
    }

    retryCount += 1;
    lastErrorText = errorText;
    retryContextActive = true;

    const baseDelay = calculateRetryDelay(retryCount);
    const delayMs = Math.max(
      MIN_RETRY_DELAY_MS,
      Math.min(baseDelay, remaining ?? baseDelay),
    );
    const noticeLimit = formatRetryLimit();

    if (retryCount === 1 || retryCount % RETRY_NOTIFY_EVERY === 0) {
      safeNotify(
        ctx,
        `Provider error; retrying continuously (attempt ${retryCount}/${noticeLimit}) in ${formatDelay(delayMs)}…`,
        "warning",
      );
    }
    safeSetStatus(ctx, `retry ${retryCount}/${noticeLimit} scheduled in ${formatDelay(delayMs)}`);

    scheduleRetry(lastUserContent, delayMs, ctx);

    return {
      message: buildRetryNotice(
        message as AssistantLike,
        errorText,
        retryCount,
      ) as unknown as typeof event.message,
    };
  });

  pi.registerCommand("retry", {
    description: "Control continuous provider-error retries (status, start, stop, reset)",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";

      switch (action) {
        case "status": {
          const state = enabled ? "on" : "off";
          const chain = retryCount > 0
            ? `attempt ${retryCount}/${formatRetryLimit()}${lastErrorText ? ` — ${truncateForNotice(lastErrorText, 120)}` : ""}`
            : "idle";
          safeNotify(
            ctx,
            `pi-retry-on-error: ${state}; limit=${formatRetryLimit()}, backoff=${formatDelay(RETRY_DELAY_MS)}→${formatDelay(RETRY_MAX_DELAY_MS)}; ${chain}`,
            "info",
          );
          return;
        }

        case "start":
        case "on":
          if (!RETRIES_CONFIGURED) {
            safeNotify(ctx, "Retries are disabled by PI_RETRY_MAX_RETRIES=0.", "warning");
            return;
          }
          enabled = true;
          safeNotify(ctx, "Continuous provider-error retries enabled.", "info");
          return;

        case "stop":
        case "off":
          enabled = false;
          resetRetryState(ctx);
          safeNotify(ctx, "Continuous retries stopped; pending retry cancelled.", "info");
          return;

        case "reset":
          resetRetryState(ctx);
          safeNotify(ctx, "Retry counter and pending retry reset.", "info");
          return;

        default:
          safeNotify(ctx, "Usage: /retry [status|start|stop|reset]", "warning");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    resetRetryState(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    resetRetryState(ctx);
  });
}
