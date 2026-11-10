# pi-matrix-tools

MiniMax's **Matrix** image generation as callable tools inside pi.

| Tool | What it does |
|---|---|
| `matrix_image` | Generate new images — 1K/2K/4K, six aspect ratios, up to 4 per call |
| `matrix_enhance` | 2× super-resolution of an existing local image |
| `matrix_remove_background` | Transparent-PNG cutout of an existing local image |
| `matrix_login` | Sign in to the MiniMax account the other three use |

## Skill

The package also ships a `matrix-image` skill (`skills/matrix-image/SKILL.md`), auto-discovered
by pi from the package's `skills/` directory. It tells the agent that `matrix_image` is the
default image path in pi and to prefer it over `agnes_image` and `mmx image generate`.

pi injects every skill's **name and description** into the system prompt — the full `SKILL.md`
body is only opened if the agent decides to read it — so name and description are what drive
tool selection. `matrix-image` is named that way deliberately: it says "image" outright, matches
the `matrix_image` tool prefix, and does not imply a video capability the skill does not have.

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

Straight over HTTPS to the MiniMax agent backend:

```
POST https://agent.minimax.io/minimax-cloud/api/v1/connectors/tools/call
Authorization: Bearer <access token>
```

Every capability — `generate_image`, `enhance_image`, `remove_image_background`,
`get_asset_url`, `upload_temp_url` — is a connector tool on that one endpoint.

### Where the token comes from

The token is the OAuth credential for the public client `mcode-public`
(scope `agent.default`, audience `agent-backend`). MCode persists it at:

```
~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json
```

This extension reads that file, **refreshes the credential when it is about to expire**, and
writes the rotated credential back — same file, same schema, generation bumped. MCode reads the
same file, so there is one login shared by both, and neither has to be running for the other
to work.

**MCode does not need to be running.** It only needs to have been signed in once, so that the
credential file exists.

### Signing in

If the credential is missing or has been revoked, call `matrix_login`:

1. `matrix_login` (no arguments) returns a one-time URL and code.
2. The user opens the URL and approves it.
3. `matrix_login` again with the returned `flow_id` finishes and stores the credential.

The credential is written into the same store MCode reads, so MCode picks it up too.

> **Note on refresh tokens.** MiniMax refresh tokens are single-use: redeeming one invalidates
> it and issues a new one. The extension always writes the rotated token back, and it
> re-reads the file first so it never clobbers a credential that was refreshed in the
> meantime. Never hand a stale refresh token to `https://account.minimax.io/oauth2/token` —
> doing so can revoke the whole session.

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

matrix_login:
  flow_id             string   (optional) id from the first call
  timeout_seconds     number   (optional) wait for approval, default 240
```

`matrix_enhance` accepts PNG, JPEG or WebP up to 10 MB, short side ≥ 256px, long side
≤ 2048px.

## Environment overrides

| Variable | Purpose |
|---|---|
| `MATRIX_AUTH_DIR` | Use a credential store at this path instead of `~/.minimax/auth/...` |
| `MATRIX_REGION` | Region (`en` / `cn`) when `MATRIX_AUTH_DIR` is set |
| `MATRIX_API_BASE_URL` | Override the agent backend base URL |
| `MATRIX_ACCOUNT_BASE_URL` | Override the OAuth base URL |
| `MATRIX_ACCESS_TOKEN` | Use this bearer token directly, skipping the credential file |

## Tips

- The model rewards **explicit** prompts. Stating subject, lighting, lens, mood, texture
  and post-processing style separately reliably beats a loose one-liner.
- Legible typography works, including multi-line poster copy — still the most fragile
  category, so verify text on close inspection.
- For `matrix_enhance` and `matrix_remove_background`, prefer a subject with a clear
  silhouette; busy backgrounds produce messy mattes.
