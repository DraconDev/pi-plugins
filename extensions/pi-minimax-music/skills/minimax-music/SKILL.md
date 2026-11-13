---
name: minimax-music
description: Generate songs and covers with the MiniMax Music 3.0 API via the minimax_lyrics_generate / minimax_music_generate / minimax_music_cover_preprocess tools. Use when the user wants a song, an anthem, a jingle, background music, a track with vocals, or a cover of an existing reference audio. Use this instead of `mmx music ...` — the mmx CLI no longer ships a music command.
---

# MiniMax Music 3.0 for pi

`mmx` (mmx-cli, all 1.0.x versions) has **no music resource at all** — the `mmx music generate`
command from older releases was removed, even though paid MiniMax plans keep access to the music
API. This plugin talks to the same public HTTP endpoints mmx used to call, directly from pi:

| Tool | Endpoint | Purpose |
|---|---|---|
| `minimax_lyrics_generate` | `POST /v1/lyrics_generation` | Write/edit lyrics with structure tags |
| `minimax_music_generate` | `POST /v1/music_generation` | Generate a full song (text-to-music, instrumental, or cover) |
| `minimax_music_cover_preprocess` | `POST /v1/music_cover_preprocess` | Extract cover features + lyrics for a two-step cover (free) |

## Auth

Uses the same credentials as mmx:

1. `MINIMAX_API_KEY` environment variable, else
2. `api_key` in `~/.mmx/config.json` (written by `mmx auth login --api-key <key>`)

Region: `MINIMAX_REGION=global|cn` overrides `region` in `~/.mmx/config.json`
(default global → `https://api.minimax.io`; CN → `https://api.minimax.cn`).
`MINIMAX_BASE_URL` overrides everything.

## Workflows

### 1) Full song from a theme (recommended)

1. `minimax_lyrics_generate` with `mode: "write_full_song"`, `prompt: "<theme/style>"`
   → returns `song_title`, `style_tags`, `lyrics` (with structure tags).
2. `minimax_music_generate` with the returned `lyrics` and a `prompt` describing the
   target style (tempo, vocals, instrumentation, mood). `output_format` defaults to
   `"url"`; the tool downloads the audio immediately (links expire after 24h).

### 2) Instrumental (BGM, theme music)

`minimax_music_generate` with `is_instrumental: true` and a rich `prompt`
(required when instrumental). No lyrics needed.

### 3) Auto lyrics from prompt

`minimax_music_generate` with `lyrics_optimizer: true` and a `prompt`
(mutually exclusive with `lyrics` / `is_instrumental`).

### 4) Song with your own lyrics

`minimax_music_generate` with `lyrics: "[Verse]\n..."` and a style `prompt`.
Supported tags: `[Intro] [Verse] [Pre Chorus] [Chorus] [Interlude] [Bridge] [Outro] [Post Chorus] [Transition] [Break] [Hook] [Build Up] [Inst] [Solo]`.

### 5) Cover of an existing song (one-step)

`minimax_music_generate` with `model: "music-cover"`, `audio_url: "<url>"` or
`audio_file: "<local path>"`, and `prompt` describing the target cover style
(10–300 chars). Lyrics are auto-extracted via ASR.

### 6) Cover with modified lyrics (two-step)

1. `minimax_music_cover_preprocess` with `audio_url` or `audio_file`
   → returns `cover_feature_id` (valid 24h) and `formatted_lyrics`.
2. Edit the lyrics as the user wants, then `minimax_music_generate` with
   `model: "music-cover"`, `cover_feature_id: "<id>"`, the edited `lyrics`
   (10–1000 chars, required), and the cover-style `prompt`.

## Models

| Model | Type | Rate limit | Notes |
|---|---|---|---|
| `music-3.0` | text-to-music | 120 RPM | Default; current generation, best quality |
| `music-2.6` | text-to-music | 120 RPM | Previous generation |
| `music-3.0-free` / `music-2.6-free` | text-to-music | 3 RPM | Free tier (being discontinued per MiniMax notice) |
| `music-cover` | cover | 120 RPM | One-step or two-step cover |
| `music-cover-free` | cover | 3 RPM | Free tier (being discontinued per MiniMax notice) |

Notes from the official docs: the paid Music Generation and Lyrics Generation APIs are no
longer open to **new** users (existing paying users keep access), and the free
`*-free` music models are being discontinued. If the account has no music access, the
API returns `base_resp.status_code` 1008 (insufficient balance) or 2049/1004 (auth) —
report that instead of retrying.

## Parameters

- `audio_setting`: `{ sample_rate?: 16000|24000|32000|44100 (default 44100), bitrate?: 32000|64000|128000|256000 (default 256000), format?: "mp3"|"wav"|"pcm" (default "mp3") }`
- `output_format`: `"url"` (default, downloaded immediately) or `"hex"`
- `seed`: 0–1,000,000, covers only
- `aigc_watermark`: embed an AI-generated-content watermark
- `lyrics_file` / `audio_file`: local-path conveniences (read + encoded automatically)
- `out`: override the output path (default `.pi/generated-music/music_<timestamp>.<ext>`)

## Output

Audio files are saved under `.pi/generated-music/` in the current working directory.
`url` links expire after 24h — the tool downloads the file immediately. `trace_id` is
returned for support requests; HTTP 200 with a non-zero `base_resp.status_code` is
surfaced as an error with the API's message and a hint (1002 rate limit, 1004/2049
auth, 1008 balance, 1026 sensitive content, 2013 invalid params).
