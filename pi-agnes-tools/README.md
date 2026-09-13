# pi-agnes-tools

The single Agnes AI plugin for pi: full model catalog (text, image, video)
for both endpoints, plus image/video generation as callable tools.

## Install

```bash
pi install npm:pi-agnes-tools
```

Or from git:

```bash
pi install git:github.com/DraconDev/pi-agnes-tools
```

> Replaces `pi-agnes` — uninstall it if you have it (`pi-agnes-tools` owns the
> `agnes` / `agnes-cn` providers outright; keeping both installed causes the
> two registrations to overwrite each other).

## What it registers

### Providers / models (selectable via `/model` and `--model`)

| Provider | Region | Base URL | Auth | Models |
|---|---|---|---|---|
| `agnes` | International | `https://apihub.agnes-ai.com/v1` | `AGNES_API_KEY` | text, image, video |
| `agnes-cn` | China | `https://api.agnes-ai.cn/v1` | `AGNES_CN_API_KEY` | text, image, video |

- Seed catalog covers `agnes-2.0-flash`, `agnes-2.5-flash`, `agnes-2.5-pro`,
  `agnes-2.5-pro-alpha`, `agnes-3.0-flash`, all `agnes-image-*` and all
  `agnes-video-*`; live `/v1/models` discovery refreshes it automatically.
- `agnes-cn` only appears in the model list once it's authenticated (env var
  or `/login`) — pi hides providers with no usable key.
- Key resolution: env var → `/login`-stored key in `~/.pi/agent/auth.json`.

```bash
pi --model agnes/agnes-2.5-flash "hello"
pi --model agnes/agnes-image-2.5-flash "a fox in a misty forest"
pi --model agnes-cn/agnes-video-2.5-flash "ocean sunset pan"
```

### Tools (callable from any model — no switch needed)

| Tool | Endpoint | What it does | Default model |
|---|---|---|---|
| `agnes_image` | `POST /v1/images/generations` | Generate an image. Saves to `.pi/generated-images/`. Returns the local path and (possibly expiring) remote URL. | `agnes-image-2.5-flash` |
| `agnes_video` | `POST /v1/videos` + poll | Generate a video. Polls every 5s (up to 30 min). Saves `.mp4` to `.pi/generated-videos/`. Supports image-to-video (1 ref image) and keyframes (>1 image). | `agnes-video-2.5-flash` |

Both tools take `endpoint`: `agnes` (default, international) or `agnes-cn` (China).

```jsonc
{"name": "agnes_image", "arguments": {"prompt": "a watercolor painting of a fox in a misty pine forest"}}
{"name": "agnes_image", "arguments": {"prompt": "...", "endpoint": "agnes-cn"}}
{"name": "agnes_video", "arguments": {"prompt": "the fox slowly turns its head", "images": ["data:image/png;base64,..."]}}
```

### Parameters

**`agnes_image`**: `prompt` (required), `model` (default `agnes-image-2.5-flash`),
`endpoint` (default `agnes`), `images` (optional base64 data URIs),
`response_format` (default `png`).

**`agnes_video`**: `prompt` (required), `model` (default `agnes-video-2.5-flash`),
`endpoint` (default `agnes`), `images` (optional: 1 → image-to-video,
>1 → keyframes), `num_frames` (default 121), `frame_rate` (default 24).

## Notes

- Output paths are project-relative (`.pi/generated-images/`, `.pi/generated-videos/`).
- `executionMode: parallel` for image (fast, stateless), `sequential` for video (long-running poll loop).
- Debug: `PI_AGNES_TOOLS_DEBUG=1` logs registration decisions to stderr.
