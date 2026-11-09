# pi-matrix-tools

MiniMax's **Matrix** image generation as callable tools inside pi.

| Tool | What it does |
|---|---|
| `matrix_image` | Generate new images — 1K/2K/4K, six aspect ratios, up to 4 per call |
| `matrix_enhance` | 2× super-resolution of an existing local image |
| `matrix_remove_background` | Transparent-PNG cutout of an existing local image |

## Why this exists

The public MiniMax API exposes only `image-01` and `image-01-live`, and both hard-cap
output at **2048px**. That is what the `mmx` CLI speaks.

The Matrix connector serves a **newer, higher-resolution image model** that reaches
`4096×4096` and `6336×2688`, and it is not reachable through `api.minimax.io`. This
extension is how you get that model from pi.

Native output sizes:

| Aspect | 1K | 2K | 4K |
|---|---|---|---|
| 1:1 | 1024×1024 | 2048×2048 | 4096×4096 |
| 4:3 | 1360×1024 | 2400×1792 | — |
| 3:4 | 1024×1360 | 1792×2400 | — |
| 16:9 | 1376×768 | 2752×1536 | — |
| 9:16 | 768×1376 | 1536×2752 | 3072×5504 |
| 21:9 | 1584×672 | 3168×1344 | 6336×2688 |

## How it talks to Matrix

The `mcode-tools` CLI. It is a thin host-managed shim that reaches the Matrix backend
through a shared auth broker on a unix socket, and it needs five
`__MAVIS_MCODE_TOOLS_*` variables that the MCode host injects into its own process.

Those variables are **not** in any shell rc file, so a plain `pi` launch cannot use
`mcode-tools` as-is — it fails with *"MCode mcode-tools runtime is unavailable"*. This
extension re-discovers the live auth lease itself (newest `~/.minimax/run/mt-*/`), which
makes the tools work from a standalone pi session.

### Requirement

**MCode must be running.** The auth lease is owned by the MCode host process and only
exists for that process's lifetime. If you see *"No Matrix auth lease found"*, start
MCode and retry.

## Install

The package is already registered in `~/.pi/agent/settings.json` under `packages`:

```json
"../../Dev/pi-plugins/extensions/pi-matrix-tools"
```

Reload pi (`/reload`) or start a new session to pick it up.

To install elsewhere:

```bash
pi install /home/dracon/Dev/pi-plugins/extensions/pi-matrix-tools
```

## Usage

Images are written to `.pi/generated-images/` under the current working directory
unless `output_dir` says otherwise.

```
matrix_image:
  prompt         string   (required) detailed description
  aspect_ratio   1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 21:9   (default 1:1)
  resolution     1K | 2K | 4K                              (default 2K)
  count          1-4                                       (default 1)
  output_dir     string
  output_prefix  string

matrix_enhance / matrix_remove_background:
  image_path     string   (required) local PNG / JPEG / WebP
  output_dir     string
  output_prefix  string
```

`matrix_enhance` accepts PNG, JPEG or WebP up to 10 MB, short side ≥ 256px, long side
≤ 2048px.

## Tips

- The model rewards **explicit** prompts. Stating subject, lighting, lens, mood, texture
  and post-processing style separately reliably beats a loose one-liner.
- Legible typography works, including multi-line poster copy — still the most fragile
  category, so verify text on close inspection.
- For `matrix_enhance` and `matrix_remove_background`, prefer a subject with a clear
  silhouette; busy backgrounds produce messy mattes.
