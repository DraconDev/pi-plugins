# pi-model-filter

Hide superseded version-suffixed models from pi's `/model` selector, `Ctrl+P`
model cycling, and the `--models` CLI scope. Works across every provider —
built-in, `models.json`, and extension-registered.

## What it does

When a provider's catalog has multiple versions of the same base model, only
the highest version is shown. Older versions are removed from the available
list; stream routing and request behavior are untouched.

### Version detection

A model id is grouped under its **base name** — everything before the
rightmost run of purely numeric hyphen-separated segments:

| Model ID | Base | Version |
|---|---|---|
| `agnes-2.0` | `agnes` | `2.0` |
| `agnes-3.0` | `agnes` | `3.0` |
| `gpt-5.5` | `gpt` | `5.5` |
| `claude-sonnet-4-5` | `claude-sonnet` | `4.5` |
| `gpt` / `my-model` | — | no version, never filtered |

Within each `provider:base` group the numerically highest version wins; the
rest are hidden.

**Design boundary:** ids that end in a non-numeric qualifier are *not*
treated as versioned. `agnes-2.5-flash` and `agnes-3.0-flash` are therefore
singletons and both stay visible — this extension is safe to run alongside
Agnes even when only the `-flash` variants exist. If a provider starts
shipping both `...-2.5-flash` and `...-3.0-flash` and you want only one,
pin it with `/model-filter keep` (or improve the parser to treat `-flash`
as a qualifier, version = the digit run before it).

## Wiring into a provider-owning extension

Each pi extension gets its own `pi` API object, so a generic "patch
registerProvider for everyone" approach can't reach other extensions.
Instead, provider-owning extensions opt in explicitly by importing the pure
core. Example, from `pi-agnes-tools`:

```ts
import { filterModelsForProvider, wrapRefreshModels } from
  "../../pi-model-filter/extensions/model-filter.js";

// static seed catalog — filtered with the live config on disk
models: filterModelsForProvider(AGNES_SEED.map(toModelConfig), def.id),

// live /v1/models discovery — re-filtered on every refresh
refreshModels: wrapRefreshModels(makeRefreshModels(...), def.id),
```

`wrapRefreshModels` re-reads `~/.pi/agent/model-filter.json` on each call,
so `/model-filter enable|disable|keep|unkeep` takes effect on the next
model refresh without a `/reload`. Static lists re-apply on the next
`/reload` or new session.

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
| `/model-filter keep <provider/model-id>` | Protect a model so it survives filtering even when a newer version exists |
| `/model-filter unkeep <provider/model-id>` | Remove a model from the keep list |

## Config

Persisted at `~/.pi/agent/model-filter.json`:

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

- The filter is **additive**: it only removes models, never adds or changes
  metadata.
- Models without a numeric version tail are never filtered.
- Filtering applies to `/model`, `Ctrl+P` cycling, and `--models` scoping
  because all three read the same filtered catalog.
- No external dependencies; the pure core has no `node:fs` or pi imports,
  so it can be unit-tested under a bare `node --test` harness.

## Tests

```bash
node --test tests/*.test.mjs
```

Covers `splitVersion`, `compareVersions`, and `filterModelList` (20 cases),
including the real Agnes seed example. The pure logic is mirrored in
`tests/model-filter.test.mjs` — keep in sync when the implementation
changes.
