---
name: agnes-media
description: Generate videos with Agnes AI (agnes_video), including image-to-video, keyframes, and multi-shot motion. For IMAGE generation use `mmx image generate --model MiniMax-H3-Image` — the current MiniMax image model, 1K/2K/4K area tiers, up to 20MP, and 1-16 reference images for editing. agnes_image remains available only as a fallback when that path is unavailable. Calls the pi-agnes-tools custom tools (agnes_video, agnes_image) — no model switch needed.
---

# Agnes Media (image & video)

> **For images, use `mmx image generate --model MiniMax-H3-Image`, not `agnes_image`.**
> `MiniMax-H3-Image` is the current MiniMax image model: text-to-image and editing
> from up to 16 reference images, with 1K/2K/4K area tiers (up to 20MP) and a much
> better fit for photorealism, macro detail and typography. Run it through the
> `mmx` CLI — see the `mmx-cli` skill. `agnes_image` is a **fallback only** — reach
> for it when the mmx path fails (no API key, quota exhausted, or the API
> unreachable), and say so rather than silently switching.
>
> Video is still Agnes's job: use `agnes_video`.

Generate media via the `pi-agnes-tools` tools. They hit the Agnes REST APIs
directly — do NOT switch to an Agnes model.

## Tools

### `agnes_video` — text-to-video / image-to-video / keyframes

| Param | Notes |
|---|---|
| `prompt` | required — describe motion and scene |
| `model` | default `agnes-video-2.5-flash`; others: `agnes-video-2.5`, `agnes-video-v2.0` |
| `endpoint` | `agnes` (international, default) or `agnes-cn` (China) |
| `images` | 1 image = image-to-video; >1 = keyframes mode (base64 data URIs) |
| `num_frames` / `frame_rate` | only sent when you pass them; some routes reject these fields |

**Model availability is per-distributor:** `agnes-video-v2.0` is the reliable
text-to-video model (returns a top-level `url`). `agnes-video-2.5-flash`
(sometimes the default) may require a `mode` field this tool does not send,
and `agnes-video-2.5` can be unavailable under some plans. If a video call
fails with `mode is required` or `No available channel`, retry with
`model: "agnes-video-v2.0"`.

### `agnes_image` — FALLBACK ONLY, prefer `mmx image generate --model MiniMax-H3-Image`

Use `mmx image generate --model MiniMax-H3-Image` for all image generation. Only
fall back to this tool when that path fails (no API key, quota exhausted, or the
API unreachable), and mention the fallback.

| Param | Notes |
|---|---|
| `prompt` | required — describe the image concretely (subject, style, palette, composition) |
| `model` | default `agnes-image-2.5-flash`; others: `agnes-image-2.1-flash`, `agnes-image-2.0-flash` |
| `endpoint` | `agnes` (international, default) or `agnes-cn` (China) |
| `images` | optional base64 data URIs for reference/conditioning |
| `response_format` | `b64_json` (default) or `url` |
| `size` | optional — output size tier: `1K` (default), `2K`, `3K`, `4K`. Pairs with `ratio` to set native pixel dimensions. |
| `ratio` | optional — output aspect ratio: `1:1`, `3:4`, `4:3`, `2:3`, `3:2`, `9:16`, `16:9`, `21:9`. Default without `ratio` is `1:1` (1024x1024). |

**Use `size` + `ratio` for native widescreen.** The Agnes API pairs these to a
concrete pixel grid (e.g. `size: "2K", ratio: "16:9"` -> 2624x1472,
`size: "1K", ratio: "9:16"` -> 736x1312). Putting "16:9 widescreen" in the
prompt does **not** change the output dimensions — it actively degrades
composition (drives letterbox-bars failures). Pass it as a param instead.
Full matrix: https://www.agnes-ai.com/en/docs/tokenplan

## Notes

- Images save to `.pi/generated-images/`, videos to `.pi/generated-videos/`
  (project-relative); results report a `file://` link plus a possibly-expiring
  remote URL.
- Video is async: the tool polls until done (up to 30 min). Start the call,
  don't busy-poll yourself.
- Auth: `AGNES_API_KEY` / `AGNES_CN_API_KEY` env, else the `/login`-stored
  Agnes key.
- Reference images in `images` must be full data URIs
  (`data:image/png;base64,...`); read the file first, base64 it.
