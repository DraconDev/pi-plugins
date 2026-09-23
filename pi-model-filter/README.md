# pi-model-filter

Hide superseded version-suffixed models from pi's `/model` selector, `Ctrl+P`
model cycling, and the `--models` CLI scope. Works across every provider —
built-in, `models.json`, and extension-registered.

## What it does

When a provider's catalog has multiple versions of the same base model, only
the highest version is shown. Older versions are removed from the available
list; the stream routing and request behavior are untouched.

### Version detection

A model id is grouped under its **base name** — everything before the
rightmost run of purely numeric hyphen-separated segments:

| Model ID | Base | Version |
|---|---|---|
| `agnes-2.0` | `agnes` | `2.0` |
| `agnes-3.0` | `agnes` | `3.0` |
| `gpt-5.5` | `gpt` | `5.5` |
| `claude-sonnet-4-5` | `claude-sonnet` | `4.5` |
| `claude-sonnet-4-6` | `claude-sonnet` | `4.6` |
| `gpt` / `my-model` | — | no version, never filtered |

Within each `provider:base` group, the model with the numerically highest
version wins; the rest are hidden.

**Design boundary:** ids that end in a non-numeric qualifier are *not*
treated as versioned. `agnes-2.5-flash` and `agnes-3.0-flash` therefore stay
in their own singleton groups and are never compared against each other —
they always show. If Agnes starts shipping both `...-flash` variants at the
same time and you want one to win, that's a candidate for the
`/model-filter keep` escape hatch below (or a follow-up tweak to the parser
to treat `-flash` as a qualifier, version = the digit run before it).

## How it's wired in

The extension patches `registerProvider` / `registerNativeProvider` on the
extension `pi` object at `session_start` (after all factories have run,
before the first model refresh). Every provider registration flowing through
after that — including other extensions' static `models` arrays and their
`refreshModels` callbacks — is filtered in place. Changing the config
persists immediately; the catalog re-applies on `/reload` or a new session.

## Install

```bash
# user scope
cp -r pi-model-filter ~/.pi/agent/extensions/
```

Or load directly during development:

```bash
pi --extension ./pi-model-filter/extensions/model-filter.ts
```

## Commands

| Command | Description |
|---|---|
| `/model-filter status` | Show whether the filter is active and which models are explicitly kept |
| `/model-filter enable` | Re-enable filtering |
| `/model-filter disable` | Turn off filtering (all versions shown) |
| `/model-filter keep <provider/model-id>` | Protect a specific model so it survives filtering even when a newer version exists |
| `/model-filter unkeep <provider/model-id>` | Remove a model from the keep list |

## Config

Persisted at `~/.pi/agent/model-filter.json`:

```json
{
  "disabled": false,
  "keep": ["agnes/agnes-2.0"]
}
```

- `disabled: true` — skip all version filtering.
- `keep` — array of `"provider/model-id"` strings always shown even when a
  newer version exists in the same base group.

## Notes

- The filter is **additive**: it only removes models, never adds or changes
  metadata.
- Models without a numeric version tail are never filtered.
- Filtering applies to `/model`, `Ctrl+P` cycling, and `--models` scoping,
  because all three read the same filtered catalog.
