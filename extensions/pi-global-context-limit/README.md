# pi-global-context-limit

A soft global compaction boundary for Pi. It **never reduces a model's context window, output limit, or provider payload**. Instead, it asks Pi to run its normal compactor at an idle task boundary once context usage reaches the first configured limit:

- an absolute token limit (default `200000`), or
- a percentage of the selected model's native context window (default `80%`).

The effective boundary is therefore `min(absoluteTokenLimit, nativeContextWindow × contextPercent / 100)`.

## Setup

Add to `~/.pi/agent/settings.json`:

```json
{
  "globalContextLimit": 200000,
  "globalContextCompactionPercent": 80
}
```

Optional controls:

```json
{
  "globalContextCompactionCooldownMs": 30000,
  "globalContextCompactionHysteresisTokens": 8000
}
```

The cooldown prevents repeated requests immediately after a compaction. Hysteresis requires usage to remain beyond the boundary for a small additional margin. Neither setting changes model capacity.

## Behavior

1. The extension observes `getContextUsage()` and the selected model's native `contextWindow` at Pi's `agent_settled` boundary.
2. When the effective boundary is crossed, it calls Pi's public `ctx.compact()` once.
3. Pi remains responsible for automatic/manual compaction mechanics, the cut point, summarization, persistence, and retries.
4. `session_compact` rearms the coordinator after cooldown; `session_compact_failed` clears the in-flight request so Pi/GLLA recovery can proceed.

The extension does not write `models.json`, `models-store.json`, `auth.json`, or provider payloads. It works the same for native, user-store, extension-registered, refreshed, and frozen models because it reads only the active public context/model objects.

## Commands

| Command | Description |
|---------|-------------|
| `/context-limit` | Show the current effective boundary for the selected model |
| `/context-limit on` | Enable the coordinator for this session |
| `/context-limit off` | Disable the coordinator for this session |
| `/context-limit rebuild` | Re-read settings and evaluate the current idle boundary |

Runtime enable/disable is session-local and reversible; it does not mutate user settings.

## Why 200k and 80%?

The absolute limit bounds long-context growth even for million-token models, while the percentage protects smaller models before their native window is consumed. The earlier boundary wins. For example:

| Native context | Percentage boundary | Effective boundary |
|---------------:|--------------------:|------------------:|
| 1,000,000 | 800,000 | 200,000 |
| 200,000 | 160,000 | 160,000 |
| 128,000 | 102,400 | 102,400 |

## Compaction ownership

Pi remains the host compactor. This extension supplies no `session_before_compact` result and does not select a cut point or generate a summary. GLLA may use its public `session_before_compact` preparation hook to bound summarizer input, but Pi still owns the actual summary and persistence.
