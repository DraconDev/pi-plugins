# pi-agnes-tools

**Agnes AI image/video generation as callable pi tools** — plus a standalone
model-catalog fallback. Pairs with [`pi-agnes`](https://pi.dev/packages/pi-agnes).

## Install (recommended: both)

```bash
pi install npm:pi-agnes npm:pi-agnes-tools
```

Or from git:

```bash
pi install git:github.com/DraconDev/pi-agnes-tools
```

## What it registers

### Tools (always — no model switch needed)

| Tool | Endpoint | What it does | Default model |
|---|---|---|---|
| `agnes_image` | `POST /v1/images/generations` | Generate an image. Saves to `.pi/generated-images/`. Returns the local path and (possibly expiring) remote URL. | `agnes-image-2.5-flash` |
| `agnes_video` | `POST /v1/videos` + poll | Generate a video. Polls every 5s (up to 30 min). Saves `.mp4` to `.pi/generated-videos/`. Supports image-to-video (1 ref image) and keyframes (>1 image). | `agnes-video-2.5-flash` |

Both tools take an `endpoint` parameter:

| Value | Region | Base URL | Auth |
|---|---|---|---|
| `agnes` (default) | International | `https://apihub.agnes-ai.com/v1` | `AGNES_API_KEY` |
| `agnes-cn` | China | `https://api.agnes-ai.cn/v1` | `AGNES_CN_API_KEY` |

Key resolution order: env var → `/login`-stored key in `~/.pi/agent/auth.json`.

### Model catalog: pi-agnes owns it when present

`registerProvider` with `models` **replaces** the whole provider catalog, so two
plugins must never register the same provider. Ownership rule:

- **pi-agnes installed** → it owns `agnes` / `agnes-cn` (dynamic `/v1/models`
  discovery, `/login` auth, image/video stream routing). This plugin registers
  **only the tools** — zero overlap, zero clobbering. All models stay
  selectable via `/model` and `--model` with both endpoints
  (`agnes/...` = international, `agnes-cn/...` = China), exactly as pi-agnes provides.
- **pi-agnes absent (standalone)** → this plugin registers the full catalog
  itself at load (text + image + video for both endpoints, with `/v1/models`
  discovery and stream routing), so `/model` and `--model agnes/...` work out
  of the box.

Detection is settings-based (`pi-agnes` in any `packages` list) with a
`session_start` backstop, so behavior is load-order independent.

## Parameters

### `agnes_image`
- `prompt` (required): text prompt
- `model` (default `agnes-image-2.5-flash`): any `agnes-image-*` id
- `endpoint` (`agnes` | `agnes-cn`, default `agnes`)
- `images` (optional): array of base64 data URIs for reference/conditioning
- `response_format` (default `png`)

### `agnes_video`
- `prompt` (required): text prompt
- `model` (default `agnes-video-2.5-flash`): any `agnes-video-*` id
- `endpoint` (default `agnes`)
- `images` (optional): 1 image → image-to-video, >1 → keyframes mode
- `num_frames` (default 121), `frame_rate` (default 24)

## Example (what the LLM sees / can call)

```jsonc
// Text-to-image (uses default agnes-image-2.5-flash, international endpoint)
{"name": "agnes_image", "arguments": {"prompt": "a watercolor painting of a fox in a misty pine forest"}}

// China endpoint
{"name": "agnes_image", "arguments": {"prompt": "...", "endpoint": "agnes-cn"}}

// Image-to-video
{"name": "agnes_video", "arguments": {"prompt": "the fox slowly turns its head", "images": ["data:image/png;base64,..."]}}

// Multi-frame keyframes
{"name": "agnes_video", "arguments": {"prompt": "fly through a canyon", "images": ["data:...frame1", "data:...frame2"], "model": "agnes-video-2.5"}}
```

Or pick a model directly (pi-agnes discovery):

```bash
pi --model agnes/agnes-image-2.5-flash "a fox in a misty forest"
pi --model agnes-cn/agnes-video-2.5-flash "ocean sunset pan"
```

## Notes

- Output paths are project-relative (`.pi/generated-images/`, `.pi/generated-videos/`).
- `executionMode: parallel` for image (fast, stateless), `sequential` for video (long-running poll loop).
- Debug: `PI_AGNES_TOOLS_DEBUG=1` logs provider ownership decisions to stderr.
