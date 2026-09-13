---
name: agnes-media
description: Generate images and videos with Agnes AI. Use when the user asks for a generated image, video, illustration, texture, mockup, image-to-video, keyframes, or media content from Agnes. Calls the pi-agnes-tools custom tools (agnes_image, agnes_video) — no model switch needed.
---

# Agnes Media (image & video)

Generate media via the `pi-agnes-tools` tools. They hit the Agnes REST APIs
directly — do NOT switch to an Agnes model.

## Tools

### `agnes_image` — text-to-image / reference-conditioned image

| Param | Notes |
|---|---|
| `prompt` | required — describe the image concretely (subject, style, palette, composition) |
| `model` | default `agnes-image-2.5-flash`; others: `agnes-image-2.1-flash`, `agnes-image-2.0-flash` |
| `endpoint` | `agnes` (international, default) or `agnes-cn` (China) |
| `images` | optional base64 data URIs for reference/conditioning |
| `response_format` | default `png` |

### `agnes_video` — text-to-video / image-to-video / keyframes

| Param | Notes |
|---|---|
| `prompt` | required — describe motion and scene |
| `model` | default `agnes-video-2.5-flash`; others: `agnes-video-2.5`, `agnes-video-v2.0` |
| `endpoint` | `agnes` (default) or `agnes-cn` |
| `images` | 1 image = image-to-video; >1 = keyframes mode (base64 data URIs) |
| `num_frames` / `frame_rate` | defaults 121 / 24 |

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
