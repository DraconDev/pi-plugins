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
│   ├── pi-plugin-list-selector-modlist/  named profiles for active tools and extension packages
│   ├── pi-auto-review/                  automated project review — scans, writes TODO.md, auto-fixes
│   ├── pi-global-context-limit/         caps every model's contextWindow to one configurable limit
│   ├── pi-session-retention/             quarantines stale and high-churn loadable Pi sessions
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

### `extensions/pi-plugin-list-selector-modlist`

Named "modlist" profiles for displaying and switching Pi's active tools and extension packages.
Tool changes apply immediately; extension-package changes show a diff, require confirmation, update
only the global `packages` setting, and use Pi's supported resource reload. On first run it captures
the current setup as `default`, while trusted projects can select or override profiles in
`.pi/modlist.json`.

- Registered in `packages` as `../../Dev/pi-plugins/extensions/pi-plugin-list-selector-modlist`.
- Use `/modlist`, `/modlist status`, `/modlist list`, or `/modlist save <name>`.
- See [extensions/pi-plugin-list-selector-modlist/README.md](./extensions/pi-plugin-list-selector-modlist/README.md)
  for configuration, project behavior, and package-switching safeguards.

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

### `extensions/pi-global-context-limit`

Caps every model's `contextWindow` to a single configurable limit regardless of provider — native,
`models-store.json`, or extension-registered via `pi.registerProvider`. Provides a `globalContextLimit`
setting in `~/.pi/agent/settings.json` and `/context-limit [N|rebuild|clear]` slash commands for
runtime control.

The tricky bit: pi v0.80.8+ deep-freezes models registered via `models.json` / `models-store.json`,
AND each extension gets its own `pi` object with its own pre-bind `registerProvider` stub — so a
monkey-patch on one extension's `pi` never sees another extension's `registerProvider` call. The
workaround this extension uses is to write `modelOverrides` into `~/.pi/agent/models.json`,
applied at compose time in `provider-composer.js`. It auto-scans installed extensions under
`~/.pi/agent/extensions/` and `~/.pi/agent/npm/node_modules/pi-*/` for `pi.registerProvider` calls
so no manual editing of `models.json` is needed.

- Registered in `packages` as `../../Dev/pi-plugins/extensions/pi-global-context-limit`.
- See [extensions/pi-global-context-limit/README.md](./extensions/pi-global-context-limit/README.md) for details.

### `extensions/pi-session-retention`

Keeps Pi's `/resume` history manageable by quarantining stale, high-churn, and tiny abandoned
session JSONL files. It scans bounded header/tail slices instead of loading full transcripts, protects
recent and named sessions plus live Pi processes and fork parents, and provides `/session-retention`
commands for status, dry runs, cleanup, and restore.

- Registered in `packages` as `../../Dev/pi-plugins/extensions/pi-session-retention`.
- Quarantined runs remain recoverable for 14 days by default.
- See [extensions/pi-session-retention/README.md](./extensions/pi-session-retention/README.md) for
  policy and configuration details.

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
