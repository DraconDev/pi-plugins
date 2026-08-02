# pi-use-last-selected-thinking-level

Per-model thinking-level memory for pi: remembers the thinking level each model was last used at (or was last explicitly set to) and re-applies it when you switch back to that model.

## The problem

pi has two ways of deciding a thinking level:

- **Pinned levels** — `enabledModels` patterns in `settings.json`, e.g. `"opencode-go/deepseek-v4-flash:max"` or `"*luna*:max"`. These always apply when that model is selected.
- **A single session-global level** — when you switch to a model *without* a pin, pi just carries the current session level over and clamps it to the new model's capabilities.

There is no "what did I last use with this model" memory. Switch from a model you ran at `max` to one you ran at `low`, and back — the second model's `low` follows you, and your first model silently loses its `max`.

## What this extension does

- **Remembers** the effective thinking level of every model you use, persisted in `~/.pi/agent/thinking-memory.json`.
- **Re-applies** it when you switch to that model again (`/model` or Ctrl+P cycling) — so each model snaps back to the level you actually used with it.
- **Applies at session start** (`startup` and `/new`) for the session's active model, so your default model also starts at its remembered level.
- **Leaves `/resume` and `/fork` alone** — those keep the session's own stored level.
- **Settings pins always win** — a model pinned in `enabledModels` (e.g. `*luna*:max`) keeps its pinned level; its memory stays dormant until the pin is removed. Remove the pin later and the memory takes over automatically.
- **Notifies** briefly when a remembered level is applied on a model switch (and only when it actually changes the level).

## How it works

The extension subscribes to three events, all handled synchronously so ordering is deterministic:

- `thinking_level_select` — records the level for the active model. When the change comes from a model switch (pi updates `ctx.model` *before* firing this event, while `previousLevel` is still the outgoing model's level), it records the **outgoing** model's level instead, so switch clamps/pins never pollute the memory.
- `model_select` — looks up the incoming model's remembered level, skips pinned models, and applies it via `pi.setThinkingLevel()` (which clamps to model capabilities automatically).
- `session_start` (reason `startup`/`new`) — applies the remembered level of the active model, silently.

The state file is written atomically (temp file + rename) and tolerates missing/corrupt files.

## Installation

```bash
pi install /home/dracon/Dev/pi-plugins/pi-use-last-selected-thinking-level
# or, from the pi-plugins repo:
pi install ../../Dev/pi-plugins/pi-use-last-selected-thinking-level
```

Then `/reload` (or restart pi). To uninstall: `pi remove pi-use-last-selected-thinking-level`.

## Usage

There is nothing to configure — switching models and changing thinking levels records and applies memory automatically.

- `/thinking-memory` — list remembered levels (`provider/model: level`), with `(current)` and `[pinned by settings — dormant]` markers, plus the state file path.
- `/thinking-memory clear` — forget everything.
- `/thinking-memory clear <fragment>` — forget only models whose `provider/model` contains the fragment (e.g. `/thinking-memory clear luna`).

Forget a single model's level to make it fall back to pi's default behavior again.

## Examples

With `enabledModels: ["opencode-go/deepseek-v4-flash:max", "*luna*:max", "**"]`:

1. Start pi — deepseek-v4-flash is active. It's pinned at `max`, so nothing changes.
2. Switch to an unpinned model, set it to `low`, use it for a while.
3. Switch back to deepseek-v4-flash — the pin applies `max` (memory dormant). Switch to the unpinned model again — `low` is applied automatically, no manual re-selection.
4. Remove `*luna*:max` from `enabledModels` later — every luna model you used before now gets its remembered level instead of the pin.

## Troubleshooting

- **Nothing is remembered** — check that the extension is loaded (`pi list` / `/reload`), then change a thinking level once; the memory file appears at `~/.pi/agent/thinking-memory.json`.
- **A model always gets a level you don't want** — run `/thinking-memory clear <fragment>` for it. If it's pinned in `enabledModels`, remember pins win by design; remove the pin to let the memory apply.
- **State file corrupt** — delete `~/.pi/agent/thinking-memory.json`; the extension starts fresh and logs a warning.
