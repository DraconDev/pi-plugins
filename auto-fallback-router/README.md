# pi-auto-fallback-router

**Automatic fallback router for [pi](https://github.com/earendil-works/pi-coding-agent).**

Configure a chain of fallback models, define triggers (timeouts, error counts, error rates), and the router silently swaps to the next healthy model when the current one fails — without surfacing the failure to the user as long as a healthy fallback exists.

This is the missing companion to [`pi-retry-on-error`](https://github.com/DraconDev/pi-plugins/tree/main/extensions/pi-retry-on-error): that extension retries the **same model** on transient errors; this one swaps to a **different model** when retries would just keep hitting the same broken upstream.

---

## What's in it

- **Chain-based fallback router.** Primary → fallback #1 → fallback #2 → … The chain is a normal list; models are tried in order.
- **Multiple triggers, each tunable.** Per-request timeout (abort the slow call), consecutive errors, rolling-window error rate, optional same-model retries before falling through, safety cap per session.
- **A `/model`-like selector.** `/fallback add`, `/fallback pick`, and `/fallback` (chain editor) all use a fuzzy-search picker identical in UX to the built-in `/model` selector.
- **Per-model "sick" cooldown.** When a model fails it is marked sick for `skipFailingForMs` (default 5 min) and the router skips over it during that window.
- **Persistent config.** Chain + triggers + per-model overrides in `~/.pi/agent/fallback-router.json`. Edits via the in-app editor or by hand.
- **Live status bar.** Footer shows `fallback: on (chain=3, idx=2)` so you always know which chain entry is active.
- **Bounded retries per fall-through.** A single transient hiccup does not burn the whole chain — set `retriesBeforeFallback` to retry the same model N times before moving on.

---

## Install

### Option 1: `pi install`

```bash
pi install ./path/to/pi-auto-fallback-router
```

This registers the package in your `~/.pi/agent/settings.json` `packages` array.

### Option 2: Symlink or copy

```bash
ln -s /path/to/pi-auto-fallback-router ~/.pi/agent/extensions/pi-auto-fallback-router
```

Then add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../../Dev/pi-plugins/auto-fallback-router"
  ]
}
```

### Option 3: Quick test

```bash
pi -e /path/to/pi-auto-fallback-router
```

---

## Usage

### Open the chain editor (default)

```
/fallback
```

Opens a `/model`-style selector showing the current chain. Keys:

| Key        | Action                                            |
|------------|---------------------------------------------------|
| `a`        | Fuzzy-search add a model (same picker as `/model`) |
| `d`        | Remove the selected entry                         |
| `u` / `k`  | Move selected entry up                            |
| `U` / `j`  | Move selected entry down                          |
| `e`        | Rename the selected entry                         |
| `Enter`    | Save and close                                    |
| `q` / `Esc`| Cancel                                            |

The currently active model is marked with a green `●`. Sick models show `[sick]`.

### Add a single model

```
/fallback add
```

Fuzzy-pick a model (same picker as `/model`) and append it to the end of the chain.

### Insert at a position

```
/fallback pick
```

Fuzzy-pick a model and choose where to insert it (append / before / after).

### Remove, reorder

```
/fallback remove [idx]      # interactive picker if no idx
/fallback move <from> <to>   # 1-based indices
```

### Status and listing

```
/fallback status    # one-line: model, chain idx, fallbacks-used
/fallback list      # full dump of chain + triggers + sick marks
```

### Edit triggers

```
/fallback condition
```

Opens an interactive editor for the trigger block. Navigate with ↑↓, press Enter to edit a field, type a number, Enter to save. `p` toggles `promoteWhenHealthy`.

### Toggle the router

```
/fallback enable
/fallback disable
```

### Misc

```
/fallback reset    # clear counters, sick marks, fallbacks-used
/fallback clear    # empty the chain
/fallback skip     # toggle sick on the currently-active model
/fallback help     # command reference
```

---

## Configuration file

`~/.pi/agent/fallback-router.json` — created automatically on first save. Hand-edit or use `/fallback`.

```json
{
  "version": 1,
  "enabled": true,
  "chain": [
    { "provider": "anthropic", "id": "claude-opus-4-8", "name": "Claude Opus 4.8 (primary)" },
    { "provider": "openai",    "id": "gpt-5.5",          "name": "GPT-5.5 (fallback)" },
    { "provider": "minimax",   "id": "MiniMax-M3" }
  ],
  "triggers": {
    "timeoutMs": 60000,
    "consecutiveErrors": 2,
    "errorsInWindow": 3,
    "windowMs": 300000,
    "retriesBeforeFallback": 1,
    "retryDelayMs": 1000,
    "maxFallbacksPerSession": 10,
    "skipFailingForMs": 300000,
    "promoteWhenHealthy": false
  },
  "perModel": {
    "anthropic/claude-opus-4-8": { "timeoutMs": 120000, "skipFailingForMs": 120000 }
  }
}
```

### Trigger reference

| Field                    | Default | Meaning                                                                                  |
|--------------------------|---------|------------------------------------------------------------------------------------------|
| `timeoutMs`              | 60000   | Abort a request that stalls longer than this (ms) with no progress. `0` disables.        |
| `consecutiveErrors`      | 2       | N consecutive errors on the current model → fall through. `0` disables.                   |
| `errorsInWindow`         | 3       | N errors within `windowMs` on the current model → fall through. `0` disables.            |
| `windowMs`               | 300000  | Rolling window for `errorsInWindow`.                                                     |
| `retriesBeforeFallback`  | 1       | How many times to retry the SAME model before falling through. `0` disables retries.     |
| `retryDelayMs`           | 1000    | Delay between same-model retries.                                                        |
| `maxFallbacksPerSession` | 10      | Safety cap on auto-fallbacks in one session. `0` = unlimited.                            |
| `skipFailingForMs`       | 300000  | Mark a model sick for this long after it fails (skipped during the window). `0` disables. |
| `promoteWhenHealthy`     | false   | When a sick model's cooldown elapses, auto-revert to it if upstream in the chain.         |

### Per-model overrides

`perModel["provider/modelId"]` overrides any of the above on a per-model basis. Useful when one provider is consistently slow (give it a higher `timeoutMs`) or when one upstream is so flaky you want to skip it longer (`skipFailingForMs`).

---

## How it works

1. **Startup.** Loads `~/.pi/agent/fallback-router.json` once. Defaults are used if the file is missing or malformed.
2. **`before_provider_request`.** Starts a per-request timer with the active model's effective `timeoutMs`. The timer is cleared in `after_provider_response` (response arrived) or `message_end`.
3. **On `message_end` with `stopReason: "error"`.** Increments the current model's consecutive-error counter and window-error counter. If either trigger threshold is met, the router looks for the next non-sick chain entry, calls `pi.setModel(target)`, and re-sends the user's last message via `pi.sendUserMessage(..., { deliverAs: "followUp" })`. The error message in the session is replaced with a fallback notice (same `role: "assistant"`, `stopReason: "stop"`).
4. **On `message_end` with `stopReason: "aborted"`.** Treated as a timeout-fallback trigger ONLY if this router triggered the abort (a user abort via Ctrl-C is left alone).
5. **Same-model retries.** Before falling through, the router re-sends the user message up to `retriesBeforeFallback` times with `retryDelayMs` between attempts. Useful for transient blips that resolve in seconds.
6. **Sick cooldown.** After a model fails, it is marked sick until `now + skipFailingForMs`. The router skips sick models during fallback selection; they re-enter the pool once the cooldown elapses.
7. **User-initiated model switches (`/model`).** Honored — the router only swaps models in response to a failure trigger on the current model, not when the user manually picks a different one.

---

## Cooperation with other extensions

- **`pi-retry-on-error`**. The two compose when same-model retries are bounded: pi-retry-on-error retries every assistant/provider error, and once its retries are exhausted this router can advance to the next chain entry. Its default is now continuous, so set `PI_RETRY_MAX_RETRIES` to a finite value (or `0` to disable it) when fallback should eventually run. Alternatively set `retriesBeforeFallback: 0` here to disable this router's same-model retries and use only pi-retry-on-error for that layer.
- **`pi-use-last-selected-thinking-level`**. Independent. Thinking-level memory is per-model; this router's model-switch events still emit `model_select` and the thinking-memory extension picks them up.

---

## Safety notes

- The replacement message in `message_end` keeps the same `role: "assistant"` and copies every other field of the original so downstream consumers (compaction, usage tracking, context calculation) keep working.
- The router never silently changes a user-selected model. Switching only happens in response to a failure trigger.
- `maxFallbacksPerSession` is a hard cap; once reached, the router stops trying and surfaces the error.
- `ctx.abort()` (used to enforce timeouts) is wrapped in try/catch and the abort path never throws to the runner.
- Sick cooldown survives `/reload` (state lives in memory; the JSON config persists chain/triggers/per-model but not in-memory health counters).

---

## License

MIT.