# pi-search-skill

A [pi](https://github.com/badlogic/pi-mono) agent skill that gives the LLM
**unlimited, local, key-less web search** by talking to a tiny Rust front-end
([search-daemon](https://github.com/DraconDev/search-daemon)) backed by a
self-hosted SearXNG instance (with a direct DuckDuckGo fallback).

```
┌─────────────┐    HTTP     ┌────────────────┐    HTTP    ┌──────────────────┐
│  pi agent   │ ─────────►  │ search-daemon  │ ────────►  │  SearXNG (docker) │
│  (this skill)│   /search   │   (Rust)       │   /search │  :8888            │
└─────────────┘ ◄────────── └────────────────┘ ◄────────  └──────────────────┘
                                       │
                                       │ fallback if SearXNG down
                                       ▼
                              ┌──────────────────┐
                              │  direct engines  │
                              │  (DDG HTML, etc) │
                              └──────────────────┘
```

The whole stack runs on your machine. No API keys, no rate limits, no
third-party data sharing.

## Why

`pi-web-access` (the built-in extension) ships a `web_search` tool backed by
`perplexity | exa | gemini`, all of which require API keys. The user has run out
of free search quota. This skill + the `search-daemon` it talks to give you a
drop-in replacement that's local and free.

## Repository layout

```
pi-search-skill/
├── README.md           # this file
├── LICENSE             # MIT
├── SKILL.md            # frontmatter + agent instructions (what pi loads)
└── scripts/
    ├── search.sh       # bash helper called by the agent
    └── format_results.py  # daemon JSON -> readable list
```

`SKILL.md` is what pi actually parses (frontmatter `name`/`description` +
agent-facing instructions). Everything else in the repo is documentation and
the helper scripts that `SKILL.md` references.

## Install

### 1. Build and start the daemon

The skill only talks to the daemon, so it has to be running. Clone and start
[search-daemon](https://github.com/DraconDev/search-daemon):

```bash
git clone https://github.com/DraconDev/search-daemon.git
cd search-daemon
cargo build --release
cd deploy && docker compose up -d && cd ..
./target/release/search-daemon
# Listens on http://127.0.0.1:8765 by default.
```

See the search-daemon README for the full setup, env vars, and systemd unit.

### 2. Install the skill

This repo lives at `~/.pi/agent/skills/pi-search-skill/`. Either clone it
directly there, or symlink it from anywhere else on disk:

```bash
git clone https://github.com/DraconDev/pi-search-skill.git \
  ~/.pi/agent/skills/pi-search-skill
```

Verify pi sees the skill — its frontmatter `description` should appear in
pi's skill picker.

### 3. Point the skill at the daemon (optional)

Default: `http://127.0.0.1:8765`. Override with `PI_SEARCH_DAEMON_URL`:

```bash
# shell
export PI_SEARCH_DAEMON_URL=http://127.0.0.1:9000
```

```jsonc
// ~/.pi/settings.json
{
  "env": { "PI_SEARCH_DAEMON_URL": "http://127.0.0.1:9000" }
}
```

## Usage

### From inside pi

Ask the agent something that needs web search. The skill description tells pi
to prefer it for factual / current / API-lookup questions when built-in
`pi-web-access` is unavailable.

> "use the search skill to find the latest Rust release notes"

Or invoke it directly:

```
/skill:pi-search-skill "rust async tutorial"
```

### From the shell

```bash
~/.pi/agent/skills/pi-search-skill/scripts/search.sh "rust async tutorial"
~/.pi/agent/skills/pi-search-skill/scripts/search.sh "rust async" --max-results 5
~/.pi/agent/skills/pi-search-skill/scripts/search.sh "rust async" --json
```

Flags:

| flag | default | purpose |
|---|---|---|
| `--max-results N` | `8` | cap on results returned |
| `--json` | — | pretty-print the full daemon JSON response |
| `--raw` | — | print the daemon JSON without pretty-printing |

## What the daemon returns

```json
{
  "query": "rust async",
  "results": [
    { "title": "...", "url": "...", "snippet": "...", "engine": "startpage", "score": 3.0 }
  ],
  "source": "searxng",
  "took_ms": 714,
  "degraded": false,
  "errors": []
}
```

- `source` is `"searxng"` (primary), `"ddg-fallback"` (SearXNG was down), or
  `"none"` (both backends failed; `results` is empty and `errors[]` is filled).
- `degraded: true` means a backend errored but partial results were returned.

Full response shape and error semantics are documented in the
[search-daemon API section](https://github.com/DraconDev/search-daemon#api).

## Worked example

```bash
$ ./scripts/search.sh "rust async tutorial" --max-results 3
results for: rust async tutorial
source: searxng  took_ms: 412  degraded: False

1. Async Rust — Tokio
   https://tokio.rs/tokio/tutorial
   A guided tour of the Tokio runtime: tasks, futures, channels, I/O ...

2. Asynchronous Programming in Rust
   https://rust-lang.github.io/async-book/
   The official async book. Covers futures, pinning, executors, and `async`/`await`.

3. Async/Await in Stable Rust
   https://blog.rust-lang.org/2019/11/07/Async-await-stable.html
   The 2019 stabilization announcement. Explains the design and trade-offs.
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `search.sh: connection refused` | daemon not running | `./target/release/search-daemon &` (from the search-daemon repo) |
| `--json` shows `source: ddg-fallback` | SearXNG is down or unhealthy | `docker compose -f deploy/compose.yaml up -d` in the search-daemon repo |
| Empty results, `source: none`, `errors` populated | both backends failed | check `errors[]`; DDG may be rate-limiting; try a different query |
| `degraded: true` | one backend errored but partial result returned | treat the answer as lower confidence; check `errors[]` |
| Slow first query (1-3s) | SearXNG cold-aggregating across engines | normal; identical queries are cached for 60s by the daemon |
| Skill not visible in pi | `SKILL.md` frontmatter broken | run `pi doctor` (or restart pi) — frontmatter must have `name` and `description` |
| `PI_SEARCH_DAEMON_URL` changes ignored | shell env vs `~/.pi/settings.json` precedence | the env var wins; export it in the shell pi was launched from |

## Security & privacy

- The daemon binds to `127.0.0.1` by default — only local processes can reach
  it. Override `SEARCH_DAEMON_BIND` only on a trusted network.
- The skill makes **no outbound calls** itself; it only talks to the local
  daemon. The daemon in turn talks to your self-hosted SearXNG, which
  aggregates public engines. SearXNG and DDG see your IP, not the daemon's
  upstream keys.
- No telemetry, no analytics, no phone-home.

## Related

- [search-daemon](https://github.com/DraconDev/search-daemon) — the Rust
  front-end this skill wraps.
- [pi](https://github.com/badlogic/pi-mono) — the coding agent this skill
  plugs into.

## License

MIT. See [LICENSE](./LICENSE).
