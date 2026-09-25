# pi-context-compaction-cap

An explicit, durable Pi compaction cap for one repository. It is **not installed or enabled by default**. When explicitly installed and configured, it caps every composed model at one token limit while leaving Pi responsible for threshold/overflow detection, the compactor, cut point, summarization, persistence, and retries.

The durable path uses Pi's public `ModelRegistry` and `models.json` composition layer, so it covers built-in/native, `models-store.json` user-store, extension-registered, refreshed, and frozen model entries without mutating frozen catalogs or the user model store.

## Explicit setup

Add the package path to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../../Dev/pi-plugins/extensions/pi-context-compaction-cap"
  ],
  "globalContextLimit": 200000
}
```

If you do not add the package to `packages`, Pi does not load it. The repository copy can therefore be maintained and live-tested without affecting normal sessions.

## Behavior when explicitly enabled

1. Observe every model composed into Pi's public `ModelRegistry`.
2. Write managed `modelOverrides` into `~/.pi/agent/models.json` and refresh the registry.
3. Re-apply on session start, model selection, and turn start.
4. Keep near-cap positive one-token provider requests at a usable 1,024-token floor.
5. Leave genuinely over-cap requests unchanged so Pi's overflow recovery remains authoritative.

## Commands

| Command | Description |
|---------|-------------|
| `/context-compaction-cap` | Show the current configured cap |
| `/context-compaction-cap 100000` | Set the cap to 100K tokens |
| `/context-compaction-cap rebuild` | Rebuild managed overrides from the live registry |
| `/context-compaction-cap clear` | Remove extension-managed overrides and restore prior user values |

## Compaction ownership

Pi triggers normal compaction when projected context exceeds its effective window minus the configured reserve. This extension does not supply a `CompactionResult`, select a cut point, or replace the host compactor. GLLA may bound `session_before_compact` preparation when explicitly loaded, but Pi still performs summarization, persistence, and retries.

Near-cap requests receive at least a 1,024-token response budget when bounded input still fits. An already-over-cap request is never given a fabricated positive budget; Pi handles it through overflow recovery.

## Managed state

`context-compaction-cap-state.json` records prior user values. `/context-compaction-cap clear` restores them and removes only fields still owned by this extension. User-authored model fields remain untouched.
