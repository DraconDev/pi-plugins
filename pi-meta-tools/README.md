# pi-meta-tools

Tools-only pi plugin for Meta media generation ([Muse Image](https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/)). No provider registration, no new login: auth reuses pi's stored Meta credential (the minted Model API key from `/login meta`) or `MODEL_API_KEY` env.

## Tools

| Tool | What it does |
|---|---|
| `meta_image` | Text-to-image via `muse-image-1.0` (no model switch needed) |
| `meta_image_edit` | Edit one image or compose from several references (paths, URLs, or data URIs) |

Both save local copies under `.pi/generated-images/` (project-relative) and return saved paths plus remote URLs.

### `meta_image` params

| Param | Notes |
|---|---|
| `prompt` | required — describe the image concretely |
| `model` | default `muse-image-1.0` |
| `n` | 1-10 (default 1) |
| `size` | aspect hint like `1024x1024` — not exact pixels |
| `output_format` | `webp`, `png` (default), `jpeg` |
| `reasoning_strength` | `high` (default) or `low` (faster, skips self-refinement) |
| `enable_web_search` / `enable_image_search` / `enable_shell` | agentic tool use, all default true |

`meta_image_edit` takes the same params plus required `images` (array of local paths, http(s) URLs, or data URIs).

## Install

From the `pi-plugins` checkout:

```bash
cd /home/dracon/Dev/pi-plugins
pi install ./pi-meta-tools
```

This registers the package in `~/.pi/agent/settings.json`. Verify with `/tools` or by asking pi to generate an image. To unload: `pi remove ./pi-meta-tools`.

## Auth

Resolution order (first hit wins):

1. `MODEL_API_KEY` (also accepts `META_MODEL_API_KEY`, `META_API_KEY`, `MUSE_API_KEY`)
2. `pi auth print-bearer-token --provider meta` — pi's stored Meta login, auto-refreshed when expired
3. Direct read of the minted key in `~/.pi/agent/auth.json`

`META_MODEL_API_BASE_URL` overrides the API base (default `https://api.meta.ai/v1`).

## Skill

The bundled `meta-media` skill auto-loads when the user asks for generated/edited images, so the agent reaches for these tools without a model switch.

## Troubleshooting

- **"not available for subscription accounts"**: Muse Image rejects Muse
  subscription keys — it needs a pay-as-you-go key with billing enabled.
  Create one at <https://dev.meta.ai/docs/authentication> and set it as
  `MODEL_API_KEY`. (Verified live: the tool, auth, and request pipeline all
  work; only billing blocks generation on subscription accounts.)
- **401/403 from the API**: pi's minted Meta key may lack image scope. Create a Model API key at <https://dev.meta.ai/docs/authentication> and set it as `MODEL_API_KEY`.
- **No Meta credential found**: run `/login` with the `meta` provider in pi, or set `MODEL_API_KEY`.
- **Slow generations**: Muse Image is agentic (search/code tools + self-refinement). Start the call and wait; don't re-issue.

## API reference

- Text-to-image: `POST {baseUrl}/images/generations`
- Edits: `POST {baseUrl}/images/edits` with `images: [{image_url}]`
- Request/response shape verified against Meta Model API docs and the [opentryon Muse adapter](https://github.com/tryonlabs/opentryon).

## License

MIT. See [LICENSE](./LICENSE).
