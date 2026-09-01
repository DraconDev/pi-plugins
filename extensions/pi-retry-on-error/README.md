# pi-retry-on-error

Automatically retries **every assistant/provider error** in [pi](https://github.com/earendil-works/pi-coding-agent).

The default policy is intentionally continuous: after an assistant message ends with
`stopReason: "error"`, the extension re-sends the original user message until it succeeds,
the user starts a different prompt, `/retry stop` is run, or the session shuts down. Retries use
exponential backoff instead of hammering an unavailable provider.

This covers provider-agnostic failures such as HTTP 4xx/5xx responses, unavailable gateways,
timeouts, connection failures, and model overload errors. No provider-specific error allowlist is
used.

## Safety boundaries

- `stopReason: "aborted"` is never retried; pressing Escape remains a reliable way to cancel.
- Tool-result errors are not replayed. Re-running a whole prompt after a failed `bash`, `write`, or
  other side-effecting tool could repeat the side effect. Pi's normal agent loop can handle tool
  errors itself.
- `/retry stop` cancels the pending timer immediately. `/retry start` enables it again for future
  errors; `/retry reset` cancels the current chain while leaving the feature enabled.
- Endless mode is configurable. Set a retry count or a duration when a bounded policy is safer.
- The retry content is copied, so text and image prompts are both supported.

## Install / load

### Option 1: install as a package

```bash
# From npm
pi install npm:pi-retry-on-error

# From this monorepo (path or git ref)
pi install /path/to/pi-plugins/extensions/pi-retry-on-error
pi install git:github.com/DraconDev/pi-plugins/extensions/pi-retry-on-error@v2.0.0
```

### Option 2: drop the directory into auto-discovery

```bash
ln -s /path/to/pi-plugins/extensions/pi-retry-on-error ~/.pi/agent/extensions/pi-retry-on-error
```

Pi auto-discovers from `~/.pi/agent/extensions/` (global) and `.pi/extensions/` (project-local).
`/reload` re-loads on the fly.

### Option 3: pin via `~/.pi/agent/settings.json`

```json
{
  "extensions": [
    "/path/to/pi-plugins/extensions/pi-retry-on-error"
  ]
}
```

### Option 4: try without installing

```bash
pi -e /path/to/pi-retry-on-error
```

## Configuration

Environment variables are read once when the extension loads.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_RETRY_MAX_RETRIES` | `unlimited` | Automatic retries after an error. `0` disables retries; a positive integer bounds them. `unlimited`, `infinite`, and `inf` are also accepted. |
| `PI_RETRY_DELAY_MS` | `5000` | Initial delay before retry, clamped to at least 100 ms. |
| `PI_RETRY_BACKOFF_MULTIPLIER` | `2` | Multiplier applied after each failed attempt; values below `1` are ignored. |
| `PI_RETRY_MAX_DELAY_MS` | `60000` | Maximum delay between attempts. It is never lower than the initial delay. |
| `PI_RETRY_MAX_DURATION_MS` | `0` | Maximum duration of one retry chain. `0` means unlimited. |
| `PI_RETRY_NOTIFY_EVERY` | `5` | Show a warning notification on the first retry and every Nth retry. The footer status updates on every retry. |

### Continuous mode (default)

```bash
# Endless retries with the built-in 5s -> 60s exponential backoff
pi -e ./extensions/pi-retry-on-error
```

### Bounded mode

```bash
# At most 10 automatic retries
PI_RETRY_MAX_RETRIES=10 pi -e ./extensions/pi-retry-on-error

# Retry for at most 24 hours, regardless of attempt count
PI_RETRY_MAX_DURATION_MS=86400000 pi -e ./extensions/pi-retry-on-error

# Disable automatic retries for this process
PI_RETRY_MAX_RETRIES=0 pi -e ./extensions/pi-retry-on-error
```

For a faster but still bounded policy:

```bash
PI_RETRY_MAX_RETRIES=5 \
PI_RETRY_DELAY_MS=1000 \
PI_RETRY_MAX_DELAY_MS=15000 \
pi -e ./extensions/pi-retry-on-error
```

## Runtime commands

```text
/retry status   Show enabled state, retry limit, backoff, and current attempt
/retry start    Enable continuous retries for this session
/retry stop     Disable retries and cancel a pending retry
/retry reset    Cancel the current chain and reset its counter
```

## How it works

1. `message_start` captures the full latest user content, including image blocks.
2. `message_end` watches for any assistant message with `stopReason: "error"`.
3. The error is replaced with a notice that preserves the original assistant fields (`api`,
   `provider`, `model`, `usage`, `timestamp`, and so on). This is required because pi replaces
   finalized messages in place.
4. The original content is re-sent with `deliverAs: "followUp"` after the backoff delay.
5. Consecutive retry notices and duplicate retry prompts are removed from the provider context,
   so a long outage does not grow the effective prompt on every attempt. They remain in the
   session transcript for visibility and auditability.
6. A successful response, an abort, a new user prompt, `/retry stop`, session switch, reload, or
   shutdown clears the retry chain.

The extension never classifies or suppresses a provider error: every assistant `stopReason:
"error"` is eligible while the feature is enabled.

## Using with `auto-fallback-router`

Continuous retries intentionally keep using the current model, so they will prevent a fallback
router from taking over by default. If fallback is desired, use a finite retry count (or disable
same-model retries in the router), for example:

```bash
PI_RETRY_MAX_RETRIES=2 pi ...
```

## License

MIT
