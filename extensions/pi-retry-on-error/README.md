# pi-retry-on-error

**Automatically retry transient LLM provider errors in [pi](https://github.com/earendil-works/pi-coding-agent).**

When a provider or gateway is flaky, the same prompt often succeeds on a second or third try. This extension watches for any assistant message that ends with `stopReason: "error"` (e.g. `Error: 400 No healthy provider available for model: 0g-minimax-m3`, HTTP 5xx, timeouts, model overloaded, etc.), replaces the visible error in the session with a friendly "Retrying…" notice, and automatically re-sends the user's last message up to **2 times** (configurable).

It works with any pi provider — no provider-specific code, no duplicated retry logic.

---

## What it adds

- Automatic, transparent retry of any failed LLM turn.
- Per-session retry counter that resets on success or new user message.
- Configurable retry count and retry delay via environment variables.
- The visible error message in the session is replaced with a "Retrying (attempt N/M)…" notice so the conversation reads cleanly.
- When retries are exhausted, the **original error message is preserved in the session** and a final-failure notification is shown.
- User is notified (`ctx.ui.notify`) on every retry and every final failure — no silent failures.

---

## Install / load

### Option 1: `pi -e` flag

```bash
pi -e /path/to/pi-retry-on-error
```

### Option 2: `~/.pi/agent/settings.json` (auto-load)

```json
{
  "extensions": [
    "/path/to/pi-retry-on-error"
  ]
}
```

Drop the directory into `~/.pi/agent/extensions/` (or a project-local `.pi/extensions/`) and it is auto-discovered and hot-reloadable with `/reload`.

### Option 3: alongside an existing provider

Add the path to the same `extensions` array you use for `pi-kilo-code-provider`, `pi-openadapter-provider`, etc. Order does not matter — the extension subscribes to events from any provider.

---

## Configuration

Two environment variables, read once at extension load:

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_RETRY_MAX_RETRIES` | `2` | Number of automatic retries on error (i.e. 3 total attempts). Clamped to `>= 0`. Set to `0` to disable retries (the extension will still notify you of the error). |
| `PI_RETRY_DELAY_MS` | `1000` | Delay in milliseconds between the error and the retry. Clamped to `>= 0`. |

Examples:

```bash
# Retry up to 3 times, wait 2 seconds between attempts
PI_RETRY_MAX_RETRIES=3 PI_RETRY_DELAY_MS=2000 pi -e ./pi-retry-on-error

# Disable retries (the extension becomes a no-op for retries, but still surfaces errors)
PI_RETRY_MAX_RETRIES=0 pi -e ./pi-retry-on-error
```

---

## Behavior in detail

1. **Capture**: every time a user message starts (`message_start` with `role: "user"`), the extension captures the message text. Both `string` content and `TextContent[]` content are supported; messages with only images (no text) are skipped. A new user message also resets the retry counter.

2. **Detect error**: when an assistant message ends (`message_end` with `role: "assistant"` and `stopReason: "error"`), the extension treats it as a transient error.

3. **Decide**:
   - If the retry counter is below `PI_RETRY_MAX_RETRIES` and a user message was captured:
     - Increment the counter.
     - `ctx.ui.notify("Provider error, retrying (attempt N/M)…", "warning")`.
     - Replace the error message in the session with a friendly "⚠️ Provider returned an error: …. Retrying automatically (attempt N/M)…" notice (same `role: "assistant"`, `stopReason: "stop"`, no `errorMessage`).
     - After `PI_RETRY_DELAY_MS` ms, `pi.sendUserMessage(savedText, { deliverAs: "followUp" })` is called. `deliverAs: "followUp"` is safe whether or not the agent is currently streaming.
   - If the counter is at or above the maximum:
     - Leave the original error message visible in the session.
     - `ctx.ui.notify("Provider error after N retries: …", "error")`.
     - Reset the counter.
   - If no user text was captured (e.g. the error happened on the very first turn, or the user message had only images):
     - Leave the error visible.
     - Notify that no retry is possible.
   - If `PI_RETRY_MAX_RETRIES` is `0`:
     - Leave the error visible, notify, do not retry.

4. **Reset on success**: any assistant message that ends with a non-error, non-aborted `stopReason` (`"stop"`, `"toolUse"`, `"length"`) resets the retry counter to 0. `stopReason: "aborted"` is also non-error and resets the counter (the user cancelled, so retries don't apply).

5. **Failure-safe**: every step is wrapped so a thrown error in the retry path is caught and surfaced via `ctx.ui.notify` rather than crashing the agent loop.

---

## Notes

- The extension is provider-agnostic: it does not branch on provider name and works with any pi provider.
- It does not modify payloads (`before_provider_request`), responses (`after_provider_response`), or context (`context`). It only observes `message_start` and `message_end`.
- The retry delivery uses `deliverAs: "followUp"` so it never throws on a still-streaming turn. If the agent is idle, it sends immediately and triggers a new turn.
- The replacement message keeps the same `role: "assistant"` as the original, satisfying pi's `message_end` replacement contract.
- Aborted turns (`stopReason: "aborted"`) are never retried — that's a user-initiated cancellation, not a transient provider error.
- The original `errorMessage` is preserved in the session when retries are exhausted, so you can still see what went wrong.

---

## License

MIT
