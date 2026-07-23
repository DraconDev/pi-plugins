# pi-plugin-list-selector-modlist

Named Pi profiles ("modlists") for seeing and switching the tools and extension packages active in a session.

Pi can enable or disable tools at runtime, so tool-only changes apply immediately. Pi loads extensions as resources, so changing a profile's extension packages requires confirmation, an update to the global `settings.json`, and a Pi resource reload. This extension handles both paths.

## Features

- Shows the active profile in Pi's footer as `modlist:<name>`.
- Adds `!` when the live tools or configured extension packages have drifted from that profile.
- Creates a global `default` profile on first run from the tools and packages active at that moment.
- Merges global and project-local profiles, with project profiles taking precedence by name.
- Prompts for a profile when starting Pi in an empty, trusted project without project config.
- Remembers the chosen profile in the current session and across resource reloads.
- Captures the current setup as a new profile with `/modlist save <name>`.
- Preserves this extension and packages not managed by any profile when switching extension sets.
- Writes JSON atomically and asks before any package change or reload.

## Installation

Add this package to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../../Dev/pi-plugins/extensions/pi-plugin-list-selector-modlist"
  ]
}
```

Then start a new Pi session or run `/reload`. On its first `session_start`, the extension creates `~/.pi/agent/modlist.json` and snapshots the current tools and global package list into a profile named `default`.

## Commands

| Command | Action |
|---|---|
| `/modlist` | Open the interactive profile selector. |
| `/modlist <name>` | Switch directly to a profile. |
| `/modlist switch <name>` | Explicit form of the direct switch. |
| `/modlist list` | List profiles and mark the active one with `*`. |
| `/modlist status` | Show the active profile, live tools, desired tools/packages, configured packages, and config paths. |
| `/modlist save <name>` | Save the currently active tools and global packages as a global profile, then activate it. |

## Configuration

Global profiles live in:

```text
~/.pi/agent/modlist.json
```

Project overrides live in:

```text
<project>/.pi/modlist.json
```

Project config is read and written only when Pi trusts the project. Project profiles override global profiles with the same name; `project.default` overrides `global.default`.

Example global config:

```json
{
  "default": "default",
  "profiles": {
    "default": {
      "description": "Full everyday setup",
      "tools": ["read", "bash", "edit", "write", "todo", "advisor"],
      "extensions": [
        "npm:pi-notify-agent",
        "npm:pi-chrome",
        "npm:@juicesharp/rpiv-todo",
        "npm:@juicesharp/rpiv-advisor"
      ]
    },
    "minimal": {
      "description": "Small read/write coding setup",
      "tools": ["read", "bash", "edit", "write"],
      "extensions": []
    },
    "tools-only": {
      "description": "Change tools without touching package settings",
      "tools": ["read", "bash"]
    }
  }
}
```

Both `tools` and `extensions` are optional:

- Missing `tools` means "leave active tools unchanged."
- Missing `extensions` means "leave global packages unchanged."
- An empty `extensions` array disables packages managed by modlist profiles, while preserving unrelated packages and modlist itself.
- `extensions` accepts the same string or filtered-object package sources as Pi's `settings.json` `packages` array.

A small project file may only select a global default:

```json
{
  "default": "minimal"
}
```

It can also define project-specific profiles:

```json
{
  "default": "project",
  "profiles": {
    "project": {
      "description": "Tools for this repository",
      "tools": ["read", "bash", "edit", "write", "todo"]
    }
  }
}
```

## Empty-project behavior

When the current directory contains nothing except optional `.git` and `.pi` directories, and no trusted `.pi/modlist.json` exists, Pi shows a one-time selector at session startup. Selecting a profile stores `{ "default": "<name>" }` in `.pi/modlist.json` and switches tools immediately.

Startup does not silently rewrite global extension settings. If the chosen profile needs different packages, the extension tells you to run `/modlist <name>` so it can show the package diff and ask for confirmation before reloading.

## Extension-switching safety

When an explicit switch changes extension packages, modlist:

1. Computes packages managed by all currently defined profiles.
2. Keeps configured packages that no profile manages.
3. Keeps the modlist package itself, even if a profile omits it.
4. Shows which package sources will be enabled and disabled.
5. Requires interactive confirmation.
6. Persists the selected profile to the session.
7. Atomically replaces only the global `packages` field in `~/.pi/agent/settings.json`.
8. Calls Pi's supported `ctx.reload()` API.

This cannot unload extension code from the already-running extension instance by itself; Pi's resource reload creates the new extension/tool set. If the package set already matches, no reload occurs.

## Status indicator

- `modlist:default` — the profile matches live tools and configured packages.
- `modlist:default!` — drift detected. Run `/modlist status` for details or switch to the profile again.
- `modlist:none` — no valid profile is selected.
- `modlist:error` — initialization failed; Pi also shows an error notification.
