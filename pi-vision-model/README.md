# pi-vision-model

**mmx CLI (MiniMax VLM) vision backend for pi** — a companion to
[`@getpipher/vision`](https://pi.dev/packages/@getpipher/vision).

The strategy: **models without vision get a separate vision model to look at
images for them.** Pi models that lack image support (e.g.
`opencode-go/deepseek-v4-flash`, `input: ["text"]`) get two delegation tools
when you paste or reference images:

| Tool | Backend | Cost |
|---|---|---|
| `describe_image` (from `@getpipher/vision`) | Any vision model in pi's runtime — configured via `/vision` (we use `opencode-go/mimo-v2.5` primary, `opencode/mimo-v2.5-free` fallback) | $0.14/$0.28 per M · free fallback |
| `describe_image_mmx` (this plugin) | **`mmx vision describe` CLI** (MiniMax VLM, independent auth in `~/.mmx`) | MiniMax Token Plan |

Both tools are **capability-aware**: they're visible to the LLM only when the
active primary model is text-only. On a multimodal primary (e.g. `mimo-v2.5`,
`kimi-k3`, `gpt-5.6-luna`) they're hidden — images pass through natively,
zero wasted delegation calls.

## Install

Registered as a local package in `~/.pi/agent/settings.json`:

```json
"packages": [
  "...",
  "../../Dev/pi-plugins/pi-vision-model",
  "npm:@getpipher/vision"
]
```

Requires the `mmx` CLI (`npm i -g mmx-cli`) authenticated
(`mmx auth login --api-key sk-...`, verify with `mmx auth status`).

## Usage

- **Automatic**: the model calls `describe_image_mmx(image_path, prompt)`
  when it needs to inspect an image (visible only on text-only primaries).
- **Manual**: `/mmx-vision <image-path> [prompt...]` describes the image via
  mmx and injects the description into the conversation so the model can act
  on it. Works regardless of the active model's modality.

## Config

`~/.pi/agent/vision-model.json`:

```json
{
  "enabled": true
}
```

`enabled: false` hides `describe_image_mmx` from the LLM
(`/mmx-vision` still works).

## Current status on this machine

⚠️ **MiniMax Token Plan limit reached** — `mmx vision describe` currently
fails with `The Token Plan usage limit has been reached`, and the
`minimax/MiniMax-M3` model (same account) returns HTTP 429. Until the plan
is topped up, `describe_image_mmx` will return a clear error and the model
falls back to `describe_image` → `opencode-go/mimo-v2.5` (working).

Relevant vision models in the current catalogs:

| Provider / model | Vision | Cost | Status |
|---|---|---|---|
| `opencode-go/mimo-v2.5` | ✅ | $0.14 / $0.28 per M | ✅ working (go sub) |
| `opencode/mimo-v2.5-free` | ✅ | free | ✅ working (configured as fallback) |
| `minimax/MiniMax-M3` | ✅ | — | ❌ 429, same exhausted Token Plan |
| mmx CLI (`vision describe`) | ✅ | Token Plan | ❌ plan limit reached |
| `opencode-go/kimi-k2.6`, `qwen3.6-plus` | ✅ | $0.95/$4 · $0.5/$3 per M | ✅ working (pricier) |

## How it works

- Registers `describe_image_mmx` via `pi.registerTool` with a TypeBox schema
  (`image_path`, optional `prompt`).
- Executes `mmx vision describe --image <path> --prompt <prompt> --output json
  --quiet --non-interactive` through `ctx.exec` (60s timeout), parses the
  response defensively (OpenAI-style `choices[].message.content`, `output_text`,
  plain text fallback), and maps failures to `isError` results so the model
  sees why mmx failed.
- Visibility sync on `session_start` / `model_select` via
  `pi.getActiveTools()` read-merge-write (coexists with `@getpipher/vision`'s
  `describe_image` — same pattern).
