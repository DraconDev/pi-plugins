# pi-agnes-tools

Pi extension that exposes **Agnes AI** image/video generation as callable tools AND registers the full Agnes model catalog — no model switch required for tools, and all models selectable via `/model`. Pairs with [`pi-agnes`](https://pi.dev/packages/pi-agnes) if you want background model discovery; this works standalone too.

## Install

```bash
pi install npm:pi-agnes-tools
```

Or from git:

```bash
pi install git:github.com/DraconDev/pi-agnes-tools
```

## What it registers

### Providers / models (selectable via `/model` and `--model`)

Registers `agnes` and `agnes-cn` providers with the full model catalog, so every Agnes model shows up in the model list:

| Model | Use | Select with |
|---|---|---|
| `agnes-2.5-flash`, `agnes-2.5-pro`, `agnes-2.5-pro-alpha`, `agnes-2.0-flash` | Chat / LLM | `pi --model agnes/agnes-2.5-flash` |
| `agnes-image-2.5-flash` (**default**), `agnes-image-2.1-flash`, `agnes-image-2.0-flash` | Image generation | `pi --model agnes/agnes-image-2.5-flash` |
| `agnes-video-2.5-flash` (**default**), `agnes-video-2.5`, `agnes-video-v2.0` | Video generation | `pi --model agnes/agnes-video-2.5-flash` |

### Tools (callable from any model, no switch needed)

| Tool | Endpoint | What it does | Default model |
|---|---|---|---|
| `agnes_image` | `POST /v1/images/generations` | Generate an image. Saves to `.pi/generated-images/`. Returns the local path and (possibly expiring) remote URL. | `agnes-image-2.5-flash` |
| `agnes_video` | `POST /v1/videos` + poll | Generate a video. Polls every 5s (up to 30 min). Saves `.mp4` to `.pi/generated-videos/`. Supports image-to-video (1 ref image) and keyframes (>1 image). | `agnes-video-2.5-flash` |

## Parameters

### `agnes_image`
- `prompt` (required): text prompt
- `model` (default `agnes-image-2.5-flash`): any `agnes-image-*` id
- `endpoint` (`agnes` | `agnes-cn`, default `agnes`): which Agnes region
- `images` (optional): array of base64 data URIs for reference/conditioning
- `response_format` (default `png`)

### `agnes_video`
- `prompt` (required): text prompt
- `model` (default `agnes-video-2.5-flash`): any `agnes-video-*` id
- `endpoint` (default `agnes`)
- `images` (optional): 1 image → image-to-video, >1 → keyframes mode
- `num_frames` (default 121), `frame_rate` (default 24)

## Auth

Key resolution order:

1. `AGNES_API_KEY` / `AGNES_CN_API_KEY` env vars (same as `pi-agnes`)
2. `/login`-stored key from `~/.pi/agent/auth.json` (`agnes` provider)

| Provider | Endpoint | Env var |
|---|---|---|
| `agnes` | `https://apihub.agnes-ai.com/v1` | `AGNES_API_KEY` |
| `agnes-cn` | `https://api.agnes-ai.cn/v1` | `AGNES_CN_API_KEY` |

## Example (what the LLM sees / can call)

```jsonc
// Text-to-image (uses default agnes-image-2.5-flash)
{"name": "agnes_image", "arguments": {"prompt": "a watercolor painting of a fox in a misty pine forest"}}

// Image-to-video
{"name": "agnes_video", "arguments": {"prompt": "the fox slowly turns its head", "images": ["data:image/png;base64,..."]}}

// Multi-frame keyframes
{"name": "agnes_video", "arguments": {"prompt": "fly through a canyon", "images": ["data:...frame1", "data:...frame2"], "model": "agnes-video-2.5"}}
```

## Notes

- Output paths are project-relative (`.pi/generated-images/`, `.pi/generated-videos/`) — matches where `pi-agnes` model-based generation saves.
- `executionMode: parallel` for image (fast, stateless), `sequential` for video (long-running task, poll loop).
- Default image model is `agnes-image-2.5-flash`; pass `model` explicitly to use `2.1`/`2.0`.
