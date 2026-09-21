---
name: meta-media
description: Generate or edit images with Meta Muse Image. Use when the user asks for a generated image, illustration, texture, mockup, image edit, or multi-image composition from Meta. Calls the pi-meta-tools custom tools (meta_image, meta_image_edit) — no model switch needed.
---

# Meta Media (image generation & editing)

Generate or edit images via the `pi-meta-tools` tools. They hit Meta Model
API (`muse-image-1.0`) directly — do NOT switch models.

## Tools

### `meta_image` — text-to-image

| Param | Notes |
|---|---|
| `prompt` | required — describe the image concretely (subject, style, palette, composition) |
| `model` | default `muse-image-1.0` |
| `n` | 1-10 images (default 1) |
| `size` | aspect hint like `1024x1024`, `1024x1536` — not exact pixels |
| `output_format` | `webp`, `png` (default), `jpeg` |
| `reasoning_strength` | `high` (default, self-refines) or `low` (faster) |
| `enable_web_search` / `enable_image_search` / `enable_shell` | agentic tool use, all default true |

### `meta_image_edit` — edit / compose from references

Same params as `meta_image`, plus:

| Param | Notes |
|---|---|
| `images` | required — 1+ references: local file paths, http(s) URLs, or data URIs. 1 image = edit it; several = compose from all (prompt decides how) |

## Notes

- Images save to `.pi/generated-images/` (project-relative); results report a
  `file://` link plus a possibly-expiring remote URL.
- Muse Image is agentic: it may use search/code tools and self-refinement to
  improve accuracy, so generations can take a while. Start the call, don't
  busy-poll yourself.
- Auth: pi's stored Meta credential (`/login meta`) or `MODEL_API_KEY` env.
  `META_MODEL_API_BASE_URL` overrides the API base (default
  `https://api.meta.ai/v1`).
- If a call fails with 401/403, the stored Meta key lacks image scope: set a
  Model API key from https://dev.meta.ai/docs/authentication as
  `MODEL_API_KEY`.
