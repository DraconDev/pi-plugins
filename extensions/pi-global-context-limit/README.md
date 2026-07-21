# pi-global-context-limit

Caps every model's `contextWindow` to a single configurable limit, regardless of the model's native context size or whether the provider was registered by a built-in provider, the `models-store.json` user store, or a third-party extension.

## Why Use This?

Different models have wildly different native context windows (Claude: 200K, GPT-4o: 128K, MiniMax-M3: 1M, Kimi K2.7: 256K-1M). If you want consistent compaction behavior and output-token budgets across all models — or just want to control token usage — this extension lets you set one number that applies to everything.

## Setup

Add to `~/.pi/agent/settings.json`:

```json
{
  "globalContextLimit": 200000
}
```

That's it. The extension will:

1. Cap the current model's `contextWindow` to the configured limit (mutating the in-memory model object for native providers, and writing a `modelOverrides` entry into `~/.pi/agent/models.json` for frozen native providers AND for extension-registered providers that bypass the user store).
2. Re-apply the cap whenever the model changes (`model_select`).
3. Apply the cap in `before_provider_request` so the API call output budget reflects the limit.

The extension also auto-scans your installed extensions under `~/.pi/agent/extensions/` and `~/.pi/agent/npm/node_modules/pi-*/` for `pi.registerProvider("name", { models: [{contextWindow: N, ...}] })` calls. Anything over the limit is added to `~/.pi/agent/models.json` as a `modelOverrides` entry, so the cap is applied at compose time even for providers that other extensions register with the agent.

## Commands

| Command | Description |
|---------|-------------|
| `/context-limit` | Show current limit and how many overrides are in `models.json` |
| `/context-limit 100000` | Set limit to 100K tokens at runtime |
| `/context-limit rebuild` | Re-scan providers and rewrite `~/.pi/agent/models.json` |
| `/context-limit clear` | Remove extension-managed overrides from `~/.pi/agent/models.json` |

## Effect on Compaction

Compaction triggers when `contextTokens > contextWindow - reserveTokens`. With a global limit:

- 200K model capped to 200K → compaction at ~168K tokens (no change)
- 1M model capped to 200K → compaction at ~168K tokens (instead of ~984K)
- 128K model capped to 200K → compaction at ~112K tokens (no change, already under limit)

## How It Works (Mechanics)

pi v0.80.8+ deep-freezes entries in `models.json` and `models-store.json` (so naive `model.contextWindow = N` throws `TypeError: Cannot assign to read only property 'contextWindow'`). The extension handles all three provider-registration paths:

| Source of model | How the cap is applied |
|-----------------|------------------------|
| `models-store.json` (native providers like `opencode-go`, `kimi-coding`) | `models.json` `modelOverrides` written by extension at startup, picked up before deepFreeze via `provider-composer.js:composeModelProvider` |
| Extension-registered (e.g. `pi-minimax-m3-caching-fix`'s `minimax-m3-clean`) | Same `models.json` `modelOverrides` mechanism — auto-discovered by extension scan of `pi.registerProvider` calls |
| Extension-registered where the extension itself was written before this extension loaded (rare race) | Fallback: mutate the in-memory model's `contextWindow` in-place via `session_start` and `model_select` handlers (catches deepFreeze too — `Object.isFrozen()`-aware) |

## Debug

The extension writes JSONL diagnostic events to `~/.pi/agent/global-context-limit-debug.log` at strategic hook points (`session_start`, `model_select`, `agent_start`, `before_provider_request`). Each event captures the provider, model id, current `contextWindow`, and `Object.isFrozen()` status. Inspect:

```bash
tail -f /home/dracon/.pi/agent/global-context-limit-debug.log
```

Delete the file at any time; the extension recreates it on the next reload.
