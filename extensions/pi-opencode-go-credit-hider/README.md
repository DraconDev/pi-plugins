# pi-opencode-go-credit-hider

A pi extension that hides "bad deal" models from OpenCode Go by parsing the credit-allocation table on the [OpenCode Go docs page](https://opencode.ai/docs/go/) at startup and re-registering the built-in `opencode-go` provider with a filtered model list.

## Why

OpenCode Go gives you monthly credits that you spend per request. Each model has an effective credit allocation — currently `$15` or `$60`. The `$15` tier burns your monthly allotment much faster, but those models still show up alongside the `$60` tier in pi's `/model` picker and Ctrl+P cycling. They look like normal options but are almost never the right pick.

This extension hides them by default. It also has `allow` / `deny` config lists for cases where you want to override the rule for a specific model — currently no such cases exist (the docs page publishes only the effective credit allocation, no per-model promo data), but the mechanism is there for the future.

## Install

This is a project-local dev extension in the `pi-plugins` repo. Add the path to your `packages` list in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "...",
    "../../Dev/pi-plugins/extensions/pi-opencode-go-credit-hider"
  ]
}
```

Then run `pi --reload` (or `pi /reload` in interactive mode) to pick it up. Verify with `/opencode-go-credits` inside a pi session.

## How it works

On every pi startup (and every `/reload`), the extension:

1. Fetches `https://opencode.ai/docs/go/` with a 5 s timeout.
2. Parses the pricing table's `Usage` column to build a map of `modelId → creditUsd`.
3. Parses the endpoints table to map display names → model ids.
4. Loads the built-in `opencode-go` model list from `@earendil-works/pi-ai`.
5. Filters it: hide models whose effective credit is below the threshold, unless they are in the `allow` list; always hide models in the `deny` list.
6. Re-registers the `opencode-go` provider with the filtered list. The override preserves the built-in auth, baseUrl, and per-model `cost` / `compat` / `thinkingLevelMap` metadata.

### Failure modes

- **Docs page unreachable**: behaviour is controlled by `onFetchError` in the config (see below). The default is `"fail"`, which registers an empty model list so the failure is immediately visible. Set to `"passthrough"` to silently fall back to the unfiltered built-in list.
- **`PI_OFFLINE=1`**: fetch is skipped and the empty-list "fail" path runs. Same fix as above.
- **Docs page layout changes**: the extension throws an error explaining which table it could not find, and the failure path runs.

## Configuration

`~/.pi/agent/opencode-go-credit-hider.json` (created on demand; not required for the default behaviour).

```json
{
  "thresholdUsd": 60,
  "allow": [],
  "deny":  [],
  "onFetchError": "fail",
  "docsUrl": "https://opencode.ai/docs/go/",
  "fetchTimeoutMs": 5000
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `thresholdUsd` | `60` | Hide any model whose effective credit allocation is below this many dollars. The current docs page only has `$15` and `$60` tiers, so this default hides the `$15` tier and keeps the `$60` tier. |
| `allow` | `[]` | Model ids that are always kept, even if they are below the threshold. Hypothetical only: the docs page does not publish per-model promo data, so there is currently no way to detect "this $15 model is effectively $60 for me" from the page. Use this if you get an out-of-band promo and want to keep a specific model visible. |
| `deny` | `[]` | Model ids that are always hidden, even if they are at or above the threshold. Same caveat as `allow`: the docs page does not publish per-model reductions either. Use this if you have an out-of-band reason to hide a specific `$60` model. |
| `onFetchError` | `"fail"` | `"fail"` registers an empty model list when the docs page is unreachable (loud failure). `"passthrough"` leaves the built-in list untouched (silent fallback). |
| `docsUrl` | `"https://opencode.ai/docs/go/"` | Where to fetch the credit table from. Override only if OpenCode moves the page. |
| `fetchTimeoutMs` | `5000` | Abort the fetch after this many ms. |

Exact-match only. No globs. Add one model id per entry.

## Inspecting the filter

Inside a pi session:

```
/opencode-go-credits
```

Shows the source URL, the kept / hidden counts, the hidden model ids with their credit values, and whether the docs fetch succeeded.

## Interaction with other customization

- **`enabledModels` patterns** still apply on top of the filtered list. If a pattern matches a hidden model, it silently matches nothing — clean up the pattern or add the model to `allow`. Note: pi-ai's built-in `opencode-go` catalog currently has 16 models and does not include `gpt-5.6-luna` or `qwen3.8-max` (both are on the docs page at `$15` but not in the built-in list). If pi-ai ever adds them, this filter will hide them by default.
- **`models.json` per-model `modelOverrides`** still apply on top of the filtered list (pi's provider composition runs them after the extension override).
- **Custom models added for `opencode-go` in `models.json`** are NOT preserved by the override — use `allow` to keep them in the filtered list.

## Files

- `index.ts` — the extension.
- `package.json` — pi-package manifest (`pi.extensions: ["./index.ts"]`).
- `tsconfig.json` — for `bunx tsc --noEmit`.
- `README.md` — this file.

## License

MIT.
