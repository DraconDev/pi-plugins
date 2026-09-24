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

1. Observe every model already composed into Pi's public `ModelRegistry`, including native, user-store/models-store, and extension-registered models.
2. Write managed `modelOverrides` into `~/.pi/agent/models.json`, which Pi composes after native and extension model layers. Frozen catalog entries are never mutated.
3. Refresh the registry and replace the active model with its capped composition.
4. Re-apply the cap on session start, model selection, and each turn start.
5. Keep the request output budget non-degenerate near the effective cap, while leaving an already-over-cap request for Pi's normal overflow recovery.

No provider source scanner is used: extension registration is handled through the live registry and Pi's public model-composition layer.

## Commands

| Command | Description |
|---------|-------------|
| `/context-limit` | Show current limit and how many overrides are in `models.json` |
| `/context-limit 100000` | Set limit to 100K tokens at runtime |
| `/context-limit rebuild` | Rebuild managed overrides from the live Pi registry |
| `/context-limit clear` | Remove extension-managed overrides from `~/.pi/agent/models.json` |

## Effect on Compaction

Pi triggers compaction when `contextTokens > contextWindow - reserveTokens`. With a global limit:

- A 1M model capped to 200K uses Pi's normal compaction threshold against the 200K effective window.
- The extension does not replace the host compactor or choose the cut point.
- GLLA may bound the shared `session_before_compact` preparation, but Pi still performs summarization, persistence, and retries.
- Near-cap provider requests receive at least a 1,024-token response budget when the bounded request still fits. An already-over-cap request is not sent with a fabricated positive budget; Pi handles it through its overflow path.

## How It Works (Mechanics)

Pi composes `models.json` overrides after built-in providers, `models-store.json`/user models, extension registrations, and extension refreshes. The extension therefore uses one durable path for every visible source:

| Source of model | How the cap is applied |
|-----------------|------------------------|
| Built-in/native model | Managed `models.json` `modelOverrides`, then registry refresh and active-model replacement |
| `models-store.json` / user-store model | The already-composed registry entry is capped through the same public override layer; the user store is not mutated |
| Extension-registered or refreshed model | The live registry entry is capped and re-composed on startup, model selection, and turn start |
| Frozen catalog entry | Never assigned in place; the registry refresh supplies the capped replacement |

Managed state in `global-context-limit-state.json` records prior user values. `/context-limit clear` restores them and removes only fields still owned by the extension.
