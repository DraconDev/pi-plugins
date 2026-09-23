# pi-stale-model-filter

Hide superseded model versions from pi's `/model` selector, `Ctrl+P` model
cycling, and `--models` CLI scoping. No per-provider wiring required.

## How it works

On every session start (or `/reload`) the extension:

1. Reads `~/.pi/agent/models-store.json` — pi's own cache of the last
   models returned by each provider's live discovery.
2. Groups models by `provider + base name`, where the base name is
   everything around the rightmost numeric version token in the id:

   | Model ID | Base | Version |
   |---|---|---|
   | `agnes-2.0-flash` | `agnes-flash` | `2.0` |
   | `agnes-3.0-flash` | `agnes-flash` | `3.0` |
   | `gpt-5.5` | `gpt` | `5.5` |
   | `claude-sonnet-4-5` | `claude-sonnet` | `4.5` |
   | `my-model` | — | never filtered |

3. Within each group only the numerically highest version survives.
   Older versions are removed from the provider's model list.

The filter runs on **every provider** — built-in, `models.json`, and
extension-registered — without any provider-specific code. It re-applies
on session start and `/reload`.

### Example: real data

Against the user's actual `models-store.json`:

- `agnes` 3 → 1 (drops `agnes-2.0-flash`, keeps `agnes-3.0-flash`)
- `openrouter` 386 → 306 (drops 80 older versions of claude-opus, gpt, gemini, grok, etc.)
- `amazon-bedrock` 118 → 96
- `gmi` 85 → 69
- `meta` 5 → 2 (keeps `muse-spark-1.3`)

## Install

```bash
cp -r pi-stale-model-filter ~/.pi/agent/extensions/
```

Or load directly during development:

```bash
pi --extension ./pi-stale-model-filter/extensions/stale-model-filter.ts
```

## Commands

| Command | Description |
|---|---|
| `/stale-model-filter status` | Show whether the filter is active and which models are explicitly kept |
| `/stale-model-filter enable` | Re-enable filtering |
| `/stale-model-filter disable` | Turn off filtering (all versions shown) |
| `/stale-model-filter keep <provider/model-id>` | Protect a model so it survives even when a newer version exists |
| `/stale-model-filter unkeep <provider/model-id>` | Remove a model from the keep list |

## Config

Persisted at `~/.pi/agent/stale-model-filter.json`:

```json
{
  "disabled": false,
  "keep": ["agnes/agnes-2.0-flash"]
}
```

- `disabled: true` — skip all version filtering.
- `keep` — array of `"provider/model-id"` strings always shown even when a
  newer version exists in the same base group.

## Notes

- The filter is **additive**: it only removes models, never adds or
  changes metadata.
- Models without a numeric version token are never filtered.
- Filtering applies to `/model`, `Ctrl+P` cycling, and `--models` scoping
  because all three read the same filtered catalog.
- No external dependencies; pure logic is unit-testable under a bare
  `node --test` harness.

## Tests

```bash
node --test tests/*.test.mjs
```

Covers `parseModelVersion`, `compareVersions`, and `filterSuperseded`
(18 cases), including real-world examples from openrouter and agnes
catalogs.
