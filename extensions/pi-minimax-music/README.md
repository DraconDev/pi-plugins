# pi-minimax-music

MiniMax **Music 3.0** (and 2.6 / cover) for pi — exposed as three tools, because the
`mmx` CLI no longer ships a music command (removed in mmx-cli 1.0.x; `mmx --help`
lists no `music` resource) even though paid MiniMax plans keep access to the music
API. This extension calls the same public HTTP endpoints directly.

## Tools

| Tool | Endpoint | Purpose |
|---|---|---|
| `minimax_music_generate` | `POST /v1/music_generation` | Full song: text-to-music with your lyrics, `is_instrumental: true`, `lyrics_optimizer: true`, or a cover via `audio_url`/`audio_file`/`cover_feature_id` |
| `minimax_lyrics_generate` | `POST /v1/lyrics_generation` | `write_full_song` (default) or `edit` — returns title, style tags and lyrics with structure tags |
| `minimax_music_cover_preprocess` | `POST /v1/music_cover_preprocess` | Two-step covers: extract `cover_feature_id` + ASR lyrics (free), then generate with edited lyrics |

Audio is saved under `.pi/generated-music/` of the current working directory
(override with `out`). `output_format=url` files are downloaded immediately —
the links expire after 24h.

## Auth

| Setting | Resolution order |
|---|---|
| API key | `MINIMAX_API_KEY` env → `api_key` in `~/.mmx/config.json` |
| Base URL | `MINIMAX_BASE_URL` env → `MINIMAX_REGION` (`global`\|`cn`) → `region` in `~/.mmx/config.json` (default `global` → `https://api.minimax.io`, CN → `https://api.minimax.cn`) |

Any key accepted by `mmx` works — this plugin reads the same `~/.mmx/config.json`
`mmx auth login --api-key` writes.

## Install

The package is registered in `~/.pi/agent/settings.json` as
`../../Dev/pi-plugins/extensions/pi-minimax-music` (same pattern as `pi-matrix-tools`).
To install elsewhere: add the directory to pi's `packages` setting, or run
`pi install ./extensions/pi-minimax-music`.

## Models

`music-3.0` (default) · `music-3.0-free` · `music-2.6` · `music-2.6-free` ·
`music-cover` · `music-cover-free`. See [skills/minimax-music/SKILL.md](./skills/minimax-music/SKILL.md)
for the full workflows and official notes (paid music APIs are no longer open to new
users; `*-free` models are being discontinued; free tier is 3 RPM).

## Development

```bash
npm test          # node --test tests/ (validation logic, no network)
```

Validation of the wire params (prompt/lyrics lengths, cover-source exclusivity,
audio_setting enums, base_resp error mapping with hints) lives in
`music-core.mjs` — plain ESM, zero dependencies, unit-tested. `index.ts` contains
the pi tool registration and the thin HTTP/file layer.
