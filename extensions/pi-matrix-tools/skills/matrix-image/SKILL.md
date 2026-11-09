---
name: matrix-media
description: Generate images, upscale images, and remove image backgrounds with MiniMax's Matrix image model using the matrix_image, matrix_enhance and matrix_remove_background tools. Use for ANY image generation, illustration, mockup, texture or photo request in pi — this is the default and highest-quality image path available (reaches 4096x4096 and 6336x2688). Prefer it over agnes_image and over `mmx image generate`.
---

# Matrix Media (image generation)

**`matrix_image` is the default image tool in pi.** Use it for every image request
unless the user explicitly asks for another provider.

## Precedence

| Need | Use | Why |
|---|---|---|
| Generate an image | `matrix_image` | High-res Matrix model: 1K/2K/4K, six aspect ratios, up to 6336x2688 |
| Enlarge an existing image | `matrix_enhance` | 2x super-resolution via the Matrix connector |
| Cut out a background | `matrix_remove_background` | Transparent PNG via the Matrix connector |

Do **not** reach for `agnes_image` or `mmx image generate` by default:

- `mmx image generate` uses the public `image-01` model, hard-capped at **2048px**.
- `agnes_image` is a separate provider at a lower quality tier.

Both remain valid **fallbacks** when `matrix_image` fails — most often because
MCode is not running (the Matrix auth lease is owned by the MCode host process).
If a Matrix call fails with *"No Matrix auth lease found"* or *"runtime is
unavailable"*, say so and offer the fallback rather than silently switching.

## Tools

### `matrix_image` — text-to-image

| Param | Notes |
|---|---|
| `prompt` | required — describe subject, lighting, lens, mood, texture and post-processing style explicitly; the model rewards dense multi-constraint prompts |
| `aspect_ratio` | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `21:9` (default `1:1`) |
| `resolution` | `1K`, `2K`, `4K` (default `2K`) |
| `count` | 1–4 images in one call (default 1) |
| `output_dir` | default `.pi/generated-images/` under the cwd |
| `output_prefix` | base filename, no extension |

Native sizes — pass `resolution` + `aspect_ratio` as params, never as prompt text:

| Aspect | 1K | 2K | 4K |
|---|---|---|---|
| 1:1 | 1024x1024 | 2048x2048 | 4096x4096 |
| 4:3 | 1360x1024 | 2400x1792 | — |
| 3:4 | 1024x1360 | 1792x2400 | — |
| 16:9 | 1376x768 | 2752x1536 | — |
| 9:16 | 768x1376 | 1536x2752 | 3072x5504 |
| 21:9 | 1584x672 | 3168x1344 | 6336x2688 |

### `matrix_enhance` — 2x upscale

| Param | Notes |
|---|---|
| `image_path` | required — local PNG / JPEG / WebP, ≤10 MB, short side ≥256px, long side ≤2048px |
| `output_dir` | default `.pi/generated-images/` |
| `output_prefix` | base filename, no extension |

Returns the doubled dimensions. Use it when an existing image needs more detail.

### `matrix_remove_background` — transparent cutout

| Param | Notes |
|---|---|
| `image_path` | required — local image with a clear main subject |
| `output_dir` | default `.pi/generated-images/` |
| `output_prefix` | base filename, no extension |

Returns a transparent PNG. Works best with a single well-separated subject;
busy backgrounds produce messy mattes.

## Notes

- All three save under `.pi/generated-images/` (project-relative) and return a
  `file://` link to the saved file.
- `matrix_image` runs `sequential`; it can still produce up to 4 images in a
  single call via `count` — prefer that over several parallel calls.
- Requires **MCode to be running** (the Matrix auth lease belongs to the MCode
  host process). See the extension README for details.
- Strong on photorealism, macro detail, legible typography, volumetric light
  and material physics. Typography is the most fragile category — verify the
  text on close inspection before presenting it as final.
