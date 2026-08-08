# pi-vision-model

**mmx CLI (MiniMax VLM) vision backend for pi** — a companion to
[`@getpipher/vision`](https://pi.dev/packages/@getpipher/vision).

The strategy: **models without vision get a separate vision model to look at
images for them.** Pi models that lack image support (e.g.
`opencode-go/deepseek-v4-flash`, `input: ["text"]`) get two delegation tools
when you paste or reference images:

| Tool | Backend | Cost |
|---|---|---|
| `describe_image` (from `@getpipher/vision`) | **`minimax/MiniMax-M3`** — the mmx vision model, called *directly* through pi's runtime (no CLI) — primary; `opencode-go/mimo-v2.5` fallback | MiniMax Token Plan · $0.14/$0.28 per M fallback |
| `describe_image_mmx` (this plugin) | **`mmx vision describe` CLI** — manual escape hatch when you specifically want the CLI (its own `~/.mmx` auth) | MiniMax Token Plan |

> **Why no CLI for the primary path?** `mmx vision describe` is just a wrapper
> around MiniMax's API. `minimax/MiniMax-M3` is already registered in pi's
> model runtime (key in `~/.pi/agent/auth.json`), so the delegate pipeline
> (cache/retry/fallback/audit) can call it directly — no subprocess, no CLI
> dependency, and it participates in the same retry→fallback flow as any other
> model.

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

⚠️ **MiniMax Token Plan limit reached** — `minimax/MiniMax-M3` (and the mmx
CLI, same account) currently returns HTTP 429 `Token Plan usage limit has
been reached`. The delegate pipeline handles this automatically: primary is
retried (2 attempts, exponential backoff), then the fallback
`opencode-go/mimo-v2.5` serves the request. Cost today: ~3–5s extra per image
before the fallback kicks in. Once the plan is topped up, MiniMax-M3 answers
directly and the overhead disappears.

Relevant vision models in the current catalogs:

| Provider / model | Vision | Cost | Status |
|---|---|---|---|
| `minimax/MiniMax-M3` | ✅ | Token Plan | ❌ 429 until plan top-up (configured primary) |
| `opencode-go/mimo-v2.5` | ✅ | $0.14 / $0.28 per M | ✅ working (fallback) |
| `kilocode/stepfun/step-3.7-flash:free` | ✅ | free | ⚠️ works; ~30% stall rate on dense/code screenshots, single-image per request — use via `/vision-use` if desired |
| `opencode/mimo-v2.5-free` | ✅ | free | ✅ working |
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
