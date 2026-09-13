# pi-agnes-tools

Pi extension that exposes **Agnes AI** image/video generation as callable tools — no model switch required. Pairs with [`pi-agnes`](https://pi.dev/packages/pi-agnes) for model registration / auth.

## Install

```bash
pi install path:/path/to/pi-agnes-tools
```

## What it registers

| Tool | Endpoint | What it does |
|---|---|---|
| `agnes_image` | `POST /v1/images/generations` | Generate an image. Saves to `.pi/generated-images/`. Returns the local path and (possibly expiring) remote URL. |
| `agnes_video` | `POST /v1/videos` + poll | Generate a video. Polls every 5s (up to 30 min). Saves `.mp4` to `.pi/generated-videos/`. Supports image-to-video (1 ref image) and keyframes (>1 image). |

## Parameters

### `agnes_image`
- `prompt` (required): text prompt
- `model` (default `agnes-image-2.1-flash`): any `agnes-image-*` id
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

Same env vars as `pi-agnes`:

| Provider | Endpoint | Env var |
|---|---|---|
| `agnes` | `https://apihub.agnes-ai.com/v1` | `AGNES_API_KEY` |
| `agnes-cn` | `https://api.agnes-ai.cn/v1` | `AGNES_CN_API_KEY` |

## Example (what the LLM sees / can call)

```jsonc
// Text-to-image
{"name": "agnes_image", "arguments": {"prompt": "a watercolor painting of a fox in a misty pine forest"}}

// Image-to-video
{"name": "agnes_video", "arguments": {"prompt": "the fox slowly turns its head", "images": ["data:image/png;base64,..."]}}

// Multi-frame keyframes
{"name": "agnes_video", "arguments": {"prompt": "fly through a canyon", "images": ["data:...frame1", "data:...frame2"], "model": "agnes-video-2.5"}}
```

## Notes

- Output paths are project-relative (`.pi/generated-images/`, `.pi/generated-videos/`) — matches where `pi-agnes` model-based generation saves.
- `executionMode: parallel` for image (fast, stateless), `sequential` for video (long-running task, poll loop).
