# pi-model-filter

Hide superseded version-suffixed models from pi's `/model` selector and
`Ctrl+P` cycle.

## What it does

When a provider offers `foo-2.0` and `foo-3.0`, this extension keeps only
`foo-3.0` visible. It works across **every** provider — built-in, custom,
`models.json`, and extension-registered providers alike — by patching the
model list returned by `refreshModels` and the static `models` array at
registration time.

### Version detection

A model ID is considered versioned when it matches the trailing pattern:

```
-<major>
-<major>.<minor>
-<major>.<minor>.<patch>
```

Examples:

| Model ID | Base | Version |
|---|---|---|
| `agnes-2.0-flash` | `agnes` | `2.0` |
| `agnes-2.5-flash` | `agnes` | `2.5` |
| `claude-sonnet-4-5` | `claude-sonnet` | `4-5` → normalized to `4.5` |
| `gpt-5.5-2026` | `gpt` | `5.5` |
| `my-model` | — | (no version, never filtered) |

When two or more models share the same `provider:base` group, the one with
the highest version wins. The loser is removed from the available list.

## Install

```bash
# drop into user extensions
cp -r pi-model-filter ~/.pi/agent/extensions/
```

Or use it directly:

```bash
pi --extension ./pi-model-filter/extensions/model-filter.ts
```

## Commands

| Command | Description |
|---|---|
| `/model-filter status` | Show whether the filter is active and which models are explicitly kept |
| `/model-filter enable` | Re-enable filtering after disabling |
| `/model-filter disable` | Show all versions temporarily (saved to config) |
| `/model-filter keep <provider/id>` | Protect a specific model from being filtered out |
| `/model-filter unkeep <provider/id>` | Remove a model from the keep list |

## Config

Persisted at `~/.pi/agent/model-filter.json`:

```json
{
  "disabled": false,
  "keep": ["agnes/agnes-2.0-flash"]
}
```

- `disabled: true` — skip all version filtering.
- `keep` — array of `"provider/model-id"` strings that are always shown
  even when a newer version exists in the same base group.

## Notes

- The filter is **additive**: it only removes models, it never adds or
  changes metadata.
- Models with no numeric version suffix are never filtered.
- Filtering applies to `Ctrl+P` model cycling as well as the `/model`
  selector, because both read from the same `getAvailable()` snapshot.
- Extension providers can opt out of filtering entirely by not using
  numeric version suffixes in their model IDs.
