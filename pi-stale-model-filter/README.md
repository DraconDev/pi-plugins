# pi-stale-model-filter

A standalone Pi extension that hides superseded model versions from Pi's model
pickers and cycling flows. It works across every provider through Pi's live model
registry; no Agnes-specific or other per-provider wiring is required.

## What it filters

Once a session starts (and again after `/reload`), the extension:

1. Enumerates every built-in, `models.json`, and extension-registered provider.
2. Composes a stale-version filter after each provider's existing
   `filterModels` policy.
3. Refreshes Pi's cached available-model snapshot without network access.
4. Keeps the wrapper attached, so later provider catalog refreshes cannot
   reintroduce stale entries.

The filtered snapshot is used by:

- `/model` in both **all** and **scoped** views
- `Ctrl+P` model cycling
- `/scoped-models`
- model RPC commands such as `get_available_models`
- `enabledModels` / `--models` scopes after session initialization

Pi resolves `--models` before extension `session_start` handlers run. The
extension therefore also rewrites the live scoped list: a removed entry is
replaced by the newest available model in the same family when one exists. If
the currently selected model was filtered, Pi switches to that replacement.

## Version detection

Models are grouped by provider plus the text around the rightmost contiguous
numeric version token:

| Model ID | Base | Version |
|---|---|---|
| `agnes-2.0-flash` | `agnes-flash` | `2.0` |
| `agnes-3.0-flash` | `agnes-flash` | `3.0` |
| `gpt-5.5` | `gpt` | `5.5` |
| `claude-sonnet-4-5` | `claude-sonnet` | `4.5` |
| `my-model` | — | never filtered |

Within each group, only the numerically highest version remains. Qualifiers
such as `flash`, `pro`, and `coder` remain part of the base, so variants only
compete with the same variant family.

Models without a numeric version token are treated as singletons. The filter is
additive only in the sense that it removes entries: it never edits model
metadata, auth, streaming, or persistence behavior.

## Install

From this repository:

```bash
pi install ./pi-stale-model-filter
```

Then start a new Pi process or run:

```text
/reload
```

Verify the package is discovered:

```bash
pi list
```

The package's `pi.extensions` entry loads
`extensions/stale-model-filter.ts`; no copy into `~/.pi/agent/extensions` is
needed.

## Commands

| Command | Description |
|---|---|
| `/stale-model-filter status` | Show enabled state, estimated hidden entries, and kept models |
| `/stale-model-filter enable` | Enable filtering and refresh the current snapshot |
| `/stale-model-filter disable` | Disable filtering and restore the full snapshot/scope |
| `/stale-model-filter keep <provider/model-id>` | Always show a protected model |
| `/stale-model-filter unkeep <provider/model-id>` | Remove a model from the keep list |

Configuration changes apply immediately; `/reload` is not required.

Example:

```text
/stale-model-filter keep openrouter/anthropic/claude-opus-4.1
```

## Configuration

Configuration is stored at:

```text
~/.pi/agent/stale-model-filter.json
```

Example:

```json
{
  "version": 1,
  "disabled": false,
  "keep": [
    "agnes/agnes-2.0-flash"
  ]
}
```

- `disabled: true` passes all models through and restores the original scope.
- `keep` contains exact `provider/model-id` entries that survive even when a
  newer version exists.

## Known lifecycle boundary

`pi --list-models` is a startup-only command that exits before `session_start`
is dispatched, so that diagnostic listing is not filtered. Interactive model
selection, cycling, configured scopes, and RPC model availability are filtered.

## Tests

```bash
npm test
```

The unit suite covers version parsing, numeric comparison, supersession,
ordering, keep rules, disabled pass-through, empty catalogs, and realistic
OpenRouter/Agnes identifiers.
