# pi-plugins

A personal collection of Pi coding-agent plugins and skills authored by DraconDev. Single git repo,
triple-mirrored (codeberg + github + gitlab).

## Layout

```
pi-plugins/
├── .gitignore
├── LICENSE                              MIT
├── README.md                            this file
├── extensions/
│   ├── pi-chrome-auto-auth/             auto-authorizes pi-chrome for the session lifetime
│   ├── pi-auto-review/                  automated project review — scans, writes TODO.md, auto-fixes
│   └── pi-retry-on-error/               retries transient LLM provider errors transparently
└── skills/
    ├── chrome-extension-dev/            load/reload/manage unpacked Chrome extensions in dev
    └── pi-search-skill/                 unlimited local key-less web search via search-daemon
```

## What's in here

### `extensions/pi-chrome-auto-auth`

A Pi extension (npm-style package) that sets pi-chrome's persistent auth state on `globalThis` to
`{ until: "indefinite" }` before pi-chrome's factory reads it on init. Result: every Pi session
starts with `chrome_*` tools already authorized, no 15-minute re-authorization prompt.

- Registered as `packages[0]` in `~/.pi/agent/settings.json` so it loads before `npm:pi-chrome`.
- See [extensions/pi-chrome-auto-auth/README.md](./extensions/pi-chrome-auto-auth/README.md) for
  install, security model, and disabling instructions.

### `extensions/pi-auto-review`

Automated project review for Pi — scans for problems, writes TODO.md, and optionally auto-fixes in
bounded fix loops. The `autoReview` config block in `~/.pi/agent/settings.json` was previously
 Dormant (the extension was not installed). Now that it's included here and registered in
`packages`, the config takes effect.

- Registered in `packages` as `../../Dev/pi-plugins/extensions/pi-auto-review`.
- Has its own `.pi/settings.json` with detailed `focusAreas` (TypeScript errors, missing types,
  broken imports, dead code, FIXME/HACK comments, security issues).
- See [extensions/pi-auto-review/README.md](./extensions/pi-auto-review/README.md) for details.

### `extensions/pi-retry-on-error`

A Pi extension that automatically retries the user's last message when an LLM provider returns a
transient error (HTTP 5xx, network timeouts, "model overloaded", etc.). Transparent to the user —
retries happen silently up to a configurable limit.

- Registered in `packages` as `../../Dev/pi-plugins/extensions/pi-retry-on-error`.
- See [extensions/pi-retry-on-error/README.md](./extensions/pi-retry-on-error/README.md) for details.

### `skills/chrome-extension-dev`

A Pi skill that auto-loads into context when the AI is working on Chrome extension development.
Default path (Path A) drives the native GTK file picker via `xdotool` through XWayland so the AI
can load unpacked extensions without manual intervention. Three fallback paths cover the failure
modes (xdotool broken, portal picker, picker unfocused).

- Registered via `skills: ["../../Dev/pi-plugins/skills"]` in `~/.pi/agent/settings.json`; pi
  scans recursively for `SKILL.md`.
- See [skills/chrome-extension-dev/SKILL.md](./skills/chrome-extension-dev/SKILL.md) for the full
  procedure and [skills/chrome-extension-dev/references/](./skills/chrome-extension-dev/references/)
  for environment-specific notes.

### `skills/pi-search-skill`

Unlimited, local, key-less web search via search-daemon (Rust) + SearXNG or DuckDuckGo fallback.
No API keys required.

- Auto-discovered from `~/.pi/agent/skills/pi-search-skill/` (its own git repo) AND from
  `skills: ["../../Dev/pi-plugins/skills"]` (this monorepo). Pi deduplicates by name.
- See [skills/pi-search-skill/SKILL.md](./skills/pi-search-skill/SKILL.md) for setup and usage.

## What's deliberately NOT here

The following are DraconDev-authored pi extensions/skills that exist elsewhere and are NOT
consolidated into this repo. Listed for inventory completeness only.

| Item | Where it lives | Notes |
|---|---|---|
| `mmx-cli` skill | `~/.pi/agent/skills/mmx-cli/SKILL.md` | Loose, no git. Currently active (auto-discovered). |
| `pi-global-context-limit` | `DraconDev/pi-global-context-limit` (github) + loose copy at `~/.pi/agent/extensions/global-context-limit/` | Not installed. The `globalContextLimit: 200000` setting is dormant. |
| `pi-mmx-assets` | `chat/pi-mmx-assets/` | Loose, not installed. |

### Explicitly excluded (NOT ours, NOT to be moved here)

- `pi-kilo-code-provider` (chat/) — no DraconDev stamp, not ours
- `pi-openadapter-provider` (chat/) — no DraconDev stamp, not ours
- `notify-tool-errors.ts` (`~/.pi/agent/extensions/`) — no DraconDev stamp, not ours
- `rtk.ts` (`~/.pi/agent/extensions/`) — no DraconDev stamp, not ours
- All `npm:*` packages in `~/.pi/agent/npm/node_modules/pi-*` — third-party, not ours

## Adding a new plugin

1. Decide: extension (npm-style) or skill (SKILL.md)?
2. Create `extensions/<name>/` or `skills/<name>/` at the repo root.
3. Follow Pi conventions (see `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
   for extensions, `docs/skills.md` for skills).
4. Add the path to `~/.pi/agent/settings.json`:
   - `extensions` (file paths or directories) for the file-based or directory-based extension form
   - `packages` for the npm-style form (use `pi install ./extensions/<name>` so settings.json gets
     the right relative-path syntax)
   - `skills` for skills (pi scans recursively for SKILL.md)
5. `git add` + commit + push (see below)

## Committing and pushing

Before the first commit, install the secret-encryption filter on this repo:

```bash
dracon-warden once /home/dracon/Dev/pi-plugins
```

Then:

```bash
cd /home/dracon/Dev/pi-plugins
git commit -m "..."
git push codeberg main    # or: git push -u codeberg main on first push (creates the repo on the server)
git push github main
# gitlab may need manual repo create at https://gitlab.com/dracondev/pi-plugins first
```

The 3 remotes are pre-configured; SSH keys authenticate on all three (verified).

## License

MIT. See [LICENSE](./LICENSE).