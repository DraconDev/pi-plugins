---
name: pi-search-skill
description: Web search via a local self-hosted SearXNG stack (or direct DuckDuckGo fallback). Free, no API keys, no rate limits. Use when the user asks a factual question, wants current information, or needs to look up documentation, library APIs, or recent events.
---

# Pi Search Skill

Web search backed by a local search-daemon (Rust) which fronts a self-hosted SearXNG instance.
The whole stack runs on the user's machine — no API keys, no rate limits, no third-party data sharing.

## When to use

- User asks a factual question ("who is...", "what is...", "latest version of...").
- User wants documentation, library APIs, or recent events.
- User explicitly says "search the web".
- Built-in `pi-web-access` (Perplexity/Exa/Gemini) is unavailable, rate-limited, or has no API key.

Do NOT use this skill for: opening a known URL (use `webfetch`/`fetch_content`), reading local files (use the `read` tool), or shell commands (use the `bash` tool).

## Setup (one-time)

```bash
# 1. Build the Rust daemon
cd /home/dracon/Dev/search-daemon
cargo build --release

# 2. Start SearXNG in Docker
cd deploy
docker compose up -d

# 3. Start the daemon (foreground or as a systemd unit)
./target/release/search-daemon

# Daemon listens on http://127.0.0.1:8765 by default.
# Override: SEARCH_DAEMON_BIND / SEARCH_DAEMON_SEARXNG_URL env vars.
```

The skill defaults to `http://127.0.0.1:8765` for the daemon. To point it elsewhere, set `PI_SEARCH_DAEMON_URL` in your shell or `~/.pi/settings.json`'s `env` block.

## Usage

Run the bundled helper with a query:

```bash
./scripts/search.sh "rust async tutorial"
./scripts/search.sh "rust async" --max-results 5
./scripts/search.sh "rust async" --json
```

The helper:
- Calls `GET /search?q=...&max_results=...` on the daemon.
- Prints a compact, human-readable list of `{title} — {url} — {snippet}` lines.
- With `--json`, prints the daemon's full JSON response (for piping to `jq`).

## Result shape

```json
{
  "query": "rust language",
  "results": [
    { "title": "...", "url": "...", "snippet": "...", "engine": "bing", "score": 16.0 }
  ],
  "source": "searxng",
  "took_ms": 412,
  "degraded": false,
  "errors": []
}
```

`source` is `"searxng"` when the primary backend served the query, `"ddg-fallback"` when SearXNG was down and DDG HTML was used, or `"none"` when both failed (in which case `results` is empty and `errors` is populated).

`degraded: true` means the daemon served a partial result (e.g. SearXNG down, only DDG fallback available). Treat the answer as lower confidence.

## Tips

- If results are stale or empty, check daemon + SearXNG health:
  ```bash
  curl -s http://127.0.0.1:8765/healthz
  curl -s http://127.0.0.1:8765/readyz   # 503 if SearXNG is down
  ```
- For precise technical queries, pass `--max-results 5` to keep the context window small.
- The daemon caches identical queries for 60 seconds. Repeats are free.
- The skill does not make outbound calls itself — it only talks to the daemon, which is bound to 127.0.0.1.

## Failure recovery

| Symptom | Cause | Fix |
|---|---|---|
| helper exits with "connection refused" | daemon not running | `./target/release/search-daemon &` |
| helper returns `degraded: true`, `source: ddg-fallback` | SearXNG down or unhealthy | `docker compose -f deploy/compose.yaml up -d` |
| helper returns empty `results`, `source: none` | both backends failed | check `errors[]`; DDG may be blocking; try a different query |
| slow first query (1-3s) | SearXNG cold-aggregating | normal; subsequent identical queries cached |
