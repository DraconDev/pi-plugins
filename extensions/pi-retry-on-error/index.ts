/**
 * pi-retry-on-error
 *
 * A pi extension that automatically retries the user's last message when an
 * LLM provider returns a transient error (e.g. "Error: 400 No healthy provider
 * available for model: 0g-minimax-m3", HTTP 5xx, network timeouts, "model
 * overloaded", etc.).
 *
 * Why: when a provider or gateway is flaky, the same prompt often succeeds on
 * a second or third try. Without retries, the user has to manually re-send the
 * prompt after every transient failure.
 *
 * Behavior:
 *   1. The extension subscribes to `message_start` and `message_end` events.
 *   2. The text of the most recent user message is captured (string or the
 *      first text part of a content array; multi-modal messages with only
 *      images are skipped).
 *   3. When an assistant message ends with `stopReason: "error"`, the retry
 *      counter is incremented. If the counter is below `PI_RETRY_MAX_RETRIES`,
 *      the visible assistant message is replaced with a friendly "Retrying
 *      (attempt N/M)..." notice, the user is notified via `ctx.ui.notify`,
 *      and the saved user message is re-queued via `pi.sendUserMessage` with
 *      `deliverAs: "followUp"` so the retry is delivered safely without
 *      interrupting any in-flight turn.
 *   4. On the final failure (counter >= max), the original error message is
 *      left visible and the user is notified of the permanent failure.
 *   5. The retry counter is reset whenever a new user message arrives or
 *      whenever a turn ends successfully (stopReason !== "error" and
 *      !== "aborted"). Messages re-sent by this extension (retries) do not
 *      reset the counter, so retries are bounded by `PI_RETRY_MAX_RETRIES`.
 *
 * Configuration (environment variables):
 *   PI_RETRY_MAX_RETRIES  Number of automatic retries on error.
 *                          Default: 2 (so 3 total attempts).
 *                          Clamped to >= 0.
 *   PI_RETRY_DELAY_MS     Delay (ms) between the error and the retry.
 *                          Default: 1000. Clamped to >= 0.
 *
 * Provider-agnostic: works with any pi provider. Does not branch on the
 * provider name; any assistant message with `stopReason: "error"` is eligible
 * for retry.
 *
 * Safety:
 *   - The replacement message keeps the same `role: "assistant"` AND copies
 *     every other field of the original message (api, provider, model,
 *     usage, timestamp, etc.) so that downstream consumers (compaction,
 *     usage tracking, context calculation) still see a valid message. The
 *     runner's `_replaceMessageInPlace` deletes keys that are absent from
 *     the replacement, so omitting `usage` would corrupt the message.
 *   - Event handlers never throw; the setTimeout/followUp delivery is
 *     wrapped in try/catch and failures are surfaced via `ctx.ui.notify`.
 *   - Aborted turns (`stopReason: "aborted"`) are never retried.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Configuration ────────────────────────────────────────────────────────────

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

const MAX_RETRIES: number = readPositiveIntEnv("PI_RETRY_MAX_RETRIES", 2);
const RETRY_DELAY_MS: number = readPositiveIntEnv("PI_RETRY_DELAY_MS", 1000);

// ─── State ────────────────────────────────────────────────────────────────────
//
// `lastUserText` and `retryCount` are closure-local to the extension factory so
// each pi session gets a fresh, isolated state.

let lastUserText: string | null = null;
let retryCount = 0;
// Set to `true` while we are dispatching a retry via `pi.sendUserMessage`.
// Used by the `message_start` handler to distinguish a user-typed message
// (which should reset the retry counter) from a retry message we just
// re-queued (which must NOT reset the counter, otherwise the retry limit is
// never reached and the plugin loops forever on a permanent error).
let retryInFlight = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface AssistantContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface AssistantLike {
  role: "assistant";
  content: AssistantContentBlock[];
  stopReason: string;
  errorMessage?: string;
  [key: string]: unknown;
}

function extractUserText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) return text;
      }
    }
  }
  return null;
}

function truncateForNotice(text: string, max = 240): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function isAssistantError(message: { role?: unknown; stopReason?: unknown; errorMessage?: unknown }): boolean {
  if (message.role !== "assistant") return false;
  if (message.stopReason !== "error") return false;
  return true;
}

function isAssistantSuccess(message: { role?: unknown; stopReason?: unknown }): boolean {
  if (message.role !== "assistant") return false;
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

/**
 * Build a "Retrying..." notice that replaces the errored assistant message in
 * the session.
 *
 * IMPORTANT: The runner's `_replaceMessageInPlace` deletes every key on the
 * original message before copying the replacement's keys onto it. That means
 * any field we omit from the replacement (e.g. `usage`) is destroyed on the
 * original, which then breaks downstream consumers (compaction, usage
 * tracking). To stay safe we spread the original first, then override only
 * the fields the notice should change (`content`, `stopReason`,
 * `errorMessage`).
 */
function buildRetryNotice(
  original: AssistantLike & Record<string, unknown>,
  errorText: string,
  attempt: number,
  max: number,
): AssistantLike {
  const safeError = truncateForNotice(errorText || "unknown provider error");
  return {
    ...original,
    role: "assistant",
    stopReason: "stop",
    content: [
      {
        type: "text",
        text:
          `⚠️ Provider returned an error: ${safeError}\n\n` +
          `Retrying automatically (attempt ${attempt}/${max})…`,
      },
    ],
    errorMessage: undefined,
  };
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Capture the most recent user message text. A new user-typed message also
  // resets the retry counter so the next prompt starts fresh. Messages we
  // re-queue ourselves (retries) are skipped via the `retryInFlight` flag so
  // they don't reset the counter and let the retry bound hold.
  pi.on("message_start", (event) => {
    const msg = event.message as { role?: unknown; content?: unknown };
    if (msg.role !== "user") return;
    const text = extractUserText(msg.content);
    if (text === null) return;
    lastUserText = text;
    if (retryInFlight) {
      // This user message was re-queued by us; consume the flag and keep
      // the retry counter intact so PI_RETRY_MAX_RETRIES actually bounds
      // the number of attempts.
      retryInFlight = false;
      return;
    }
    retryCount = 0;
  });

  // On a successful assistant turn, reset the retry counter.
  pi.on("message_end", (event) => {
    if (isAssistantSuccess(event.message as { role?: unknown; stopReason?: unknown })) {
      retryCount = 0;
    }
  });

  // On an errored assistant message, decide whether to retry.
  pi.on("message_end", (event, ctx) => {
    const msg = event.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown; content?: unknown };
    if (!isAssistantError(msg)) return;

    const errorText = typeof msg.errorMessage === "string" ? msg.errorMessage : "unknown provider error";

    // If the user message is missing or non-text, we can't safely retry.
    if (!lastUserText) {
      ctx.ui.notify(`Provider error (no user text captured to retry): ${truncateForNotice(errorText)}`, "error");
      return;
    }

    if (MAX_RETRIES === 0) {
      // Retries are disabled. Leave the error visible and notify.
      ctx.ui.notify(`Provider error (retries disabled): ${truncateForNotice(errorText)}`, "error");
      retryCount = 0;
      return;
    }

    if (retryCount >= MAX_RETRIES) {
      // Out of retries. Leave the original error message visible and notify.
      ctx.ui.notify(
        `Provider error after ${MAX_RETRIES} ${MAX_RETRIES === 1 ? "retry" : "retries"}: ${truncateForNotice(errorText)}`,
        "error",
      );
      retryCount = 0;
      return;
    }

    retryCount += 1;
    const attempt = retryCount;
    const textToSend = lastUserText;

    ctx.ui.notify(
      `Provider error, retrying (attempt ${attempt}/${MAX_RETRIES})…`,
      "warning",
    );

    // Schedule the retry. `deliverAs: "followUp"` is safe whether or not the
    // agent is currently streaming — it queues if needed, sends immediately
    // otherwise. Wrapped in try/catch so a transport failure can't crash the
    // session. `retryInFlight` is set so the upcoming `message_start` for
    // the re-queued user message does not reset the retry counter.
    setTimeout(() => {
      retryInFlight = true;
      try {
        pi.sendUserMessage(textToSend, { deliverAs: "followUp" });
      } catch (err) {
        retryInFlight = false;
        const message = err instanceof Error ? err.message : String(err);
        try {
          ctx.ui.notify(`Retry dispatch failed: ${truncateForNotice(message)}`, "error");
        } catch {
          // Even ui.notify can fail in some edge cases; swallow so the agent
          // loop is never crashed by this extension.
        }
      }
    }, RETRY_DELAY_MS);

    // Replace the error message in the session with a friendly "Retrying…"
    // notice so the conversation reads cleanly. The replacement keeps the
    // same `role: "assistant"` as required by the message_end contract AND
    // copies every other field of the original (see `buildRetryNotice`).
    return {
      message: buildRetryNotice(
        msg as AssistantLike & Record<string, unknown>,
        errorText,
        attempt,
        MAX_RETRIES,
      ) as unknown as typeof event.message,
    };
  });
}
