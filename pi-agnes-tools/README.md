# pi-agnes-tools

The single Agnes AI plugin for [pi](https://pi.dev): **text model catalog**
(selectable via `/model`) plus **image/video generation as custom tools + skill**.
No model switch needed for media — the agent just calls a tool.

[![npm version](https://img.shields.io/npm/v/pi-agnes-tools)](https://www.npmjs.com/package/pi-agnes-tools)
[![license: MIT](https://img.shields.io/badge/license-MIT)](./LICENSE)

## Quick start

```bash
pi install npm:pi-agnes-tools
```

Export an API key, then use it:

```bash
export AGNES_API_KEY=sk-...          # international endpoint
export AGNES_CN_API_KEY=cn-sk-...    # China endpoint (optional)
```

```bash
# Text chat via the Agnes model catalog
pi --model agnes/agnes-2.5-flash "hello"

# Image / video: just ask in any pi session — the agnes-media skill teaches
# the model to call the agnes_image / agnes_video tools.
pi "Generate a 2-second video of a red apple falling off a wooden table, photorealistic"
```

Or run `/login` once and pi stores the key in `~/.pi/agent/auth.json` for you.

## What it registers

### 1. Text models (in `/model`)

Only **text/LLM** models are registered. Image/video are **not** selectable
models — they live in the tools + skill. Both regions:

| Provider | Region | Base URL | Auth |
|---|---|---|---|
| `agnes` | International | `https://apihub.agnes-ai.com/v1` | `AGNES_API_KEY` |
| `agnes-cn` | China | `https://api.agnes-ai.cn/v1` | `AGNES_CN_API_KEY` |

Seed text models: `agnes-2.0-flash`, `agnes-2.5-flash`, `agnes-2.5-pro`,
`agnes-2.5-pro-alpha`, `agnes-3.0-flash`. Live `/v1/models` discovery adds
newer text models automatically (image/video entries are filtered out).

`agnes-cn` only appears once a CN key is configured (env var or a key stored
under `agnes-cn` in `auth.json`).

### 2. Media tools + skill (any chat model)

Two ways to generate media — no `/model` switch:

- **Tools** — `agnes_image`, `agnes_video` callable by any model.
- **Skill** — `agnes-media` (auto-loaded) teaches the model how to call the
  tools: prompt shaping, reference-image handling, endpoint choice, defaults.

Defaults: image `agnes-image-2.5-flash`, video `agnes-video-2.5-flash`.
Output: `.pi/generated-images/`, `.pi/generated-videos/` (project-relative).

| Tool | Key params |
|---|---|
| `agnes_image` | `prompt`, `model`, `endpoint`, `images` (base64 data URIs), `response_format` |
| `agnes_video` | `prompt`, `model`, `endpoint`, `images` (1 = img2vid, >1 = keyframes), `num_frames`, `frame_rate` |

## Install sources

```bash
pi install npm:pi-agnes-tools
pi install git:github.com/DraconDev/pi-agnes-tools
```

> **Replaces `pi-agnes`.** This plugin owns the `agnes` / `agnes-cn` providers
> outright. Uninstall `pi-agnes` if you have it — two registrations would
> overwrite each other.

## Auth

Resolution order: `AGNES_API_KEY` / `AGNES_CN_API_KEY` env vars →
`/login`-stored key in `~/.pi/agent/auth.json`.

## Notes

- `executionMode: parallel` for image (fast, stateless); `sequential` for
  video (long-running poll, up to 30 min).
- **Video model availability is per-distributor.** In practice
  `agnes-video-v2.0` is the reliable text-to-video model (5s / 720p clip,
  completed payload carries the video at a top-level `url` — with
  `metadata.url` as a fallback; the tool handles both). `agnes-video-2.5-flash`
  may require a `mode` field this tool does not send, and `agnes-video-2.5`
  can be unavailable under some plans ("No available channel"). If the
  default `2.5-flash` fails, call the tool with `model: "agnes-video-v2.0"`.
- `num_frames` / `frame_rate` are only sent when explicitly provided — some
  video routes reject those request fields and apply their own defaults.
- Debug: `PI_AGNES_TOOLS_DEBUG=1` logs registration + request decisions to stderr.
- MIT licensed. Source: [github.com/DraconDev/pi-agnes-tools](https://github.com/DraconDev/pi-agnes-tools).
