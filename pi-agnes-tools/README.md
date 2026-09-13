# pi-agnes-tools

The single Agnes AI plugin for pi: text model catalog (selectable via `/model`)
plus image/video generation as custom tools + skill. No model switch needed
for media.

## Install

```bash
pi install npm:pi-agnes-tools
```

Or from git:

```bash
pi install git:github.com/DraconDev/pi-agnes-tools
```

> Replaces `pi-agnes` — uninstall it if you have it (this plugin owns the
> `agnes` / `agnes-cn` providers outright; keeping both installed causes the
> two registrations to overwrite each other).

## What it registers

### Models (`/model` selector)

Only **text/LLM** models are registered — image and video live in the skill
+ tools, not in the chat model list. Both regions:

| Provider | Region | Base URL | Auth |
|---|---|---|---|
| `agnes` | International | `https://apihub.agnes-ai.com/v1` | `AGNES_API_KEY` |
| `agnes-cn` | China | `https://api.agnes-ai.cn/v1` | `AGNES_CN_API_KEY` |

Text models: `agnes-2.0-flash`, `agnes-2.5-flash`, `agnes-2.5-pro`,
`agnes-2.5-pro-alpha`, `agnes-3.0-flash`. Live `/v1/models` discovery adds
newer text models automatically (image/video are filtered out).

```bash
pi --model agnes/agnes-2.5-flash "hello"
pi --model agnes-cn/agnes-2.5-flash "你好"
```

### Image / video — via tools + skill (not in `/model`)

Two ways to generate media:

1. **Tool calls** — `agnes_image`, `agnes_video` are exposed to any chat model.
2. **Skill** — `agnes-media` (auto-loaded with this package) tells the agent
   exactly how to call the tools: prompt shaping, reference-image handling,
   endpoint selection, defaults.

The LLM does not need to switch models. Default image model:
`agnes-image-2.5-flash`. Default video model: `agnes-video-2.5-flash`.

#### `agnes_image`

| Param | Notes |
|---|---|
| `prompt` | required |
| `model` | default `agnes-image-2.5-flash`; others: `agnes-image-2.1-flash`, `agnes-image-2.0-flash` |
| `endpoint` | `agnes` (default) or `agnes-cn` |
| `images` | optional base64 data URIs for reference/conditioning |
| `response_format` | default `png` |

#### `agnes_video`

| Param | Notes |
|---|---|
| `prompt` | required |
| `model` | default `agnes-video-2.5-flash`; others: `agnes-video-2.5`, `agnes-video-v2.0` |
| `endpoint` | `agnes` (default) or `agnes-cn` |
| `images` | 1 image = image-to-video; >1 = keyframes mode |
| `num_frames` / `frame_rate` | defaults 121 / 24 |

Output paths are project-relative (`.pi/generated-images/`, `.pi/generated-videos/`).

## Auth

Key resolution order: env var → `/login`-stored key in `~/.pi/agent/auth.json`.

`agnes-cn` only appears in the model list once a CN key is configured
(`AGNES_CN_API_KEY` env or a key stored under `agnes-cn` in auth.json).

## Notes

- `executionMode: parallel` for image (fast, stateless), `sequential` for video (long-running poll loop, up to 30 min).
- Debug: `PI_AGNES_TOOLS_DEBUG=1` logs registration decisions to stderr.
