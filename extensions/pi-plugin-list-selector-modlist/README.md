# pi-plugin-list-selector-modlist

Named addon-package profiles ("modlists") that layer additional extension packages on top of your immutable settings.json baseline.

## Design

Your `~/.pi/agent/settings.json` `packages` array is the immutable baseline. Modlist profiles are **only** addon packages — strings that get unioned with settings.json when a profile is active. The baseline is never removed or replaced.

This means:
- You can never accidentally lose a package that's in your settings.json.
- A buggy modlist profile simply doesn't apply (no damage).
- The `none` profile (default) means "no addons" — your settings.json runs unchanged.
- Tool switching is out of scope. Tools are always whatever pi loads from installed extensions.

## Features

- Footer shows `modlist:<name>` (or `modlist:none`).
- `!` suffix when addon packages have drifted from the active profile (e.g. someone manually edited settings.json).
- Creates `~/.pi/agent/modlist.json` with a `none` profile on first run.
- Merges global and project-local profiles (project overrides by name).
- Atomic file writes preserving existing permissions.
- Project-local config is only read/written when the project is trusted.
- Always preserves the modlist package itself in settings.json.

## Installation

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../../Dev/pi-plugins/extensions/pi-plugin-list-selector-modlist"
  ]
}
```

Or install from npm:

```bash
pi install npm:pi-plugin-list-selector-modlist
```

## Commands

| Command | Action |
|---|---|
| `/modlist` | Open the interactive profile selector. |
| `/modlist <name>` | Switch directly to a profile. |
| `/modlist switch <name>` | Explicit form of the direct switch. |
| `/modlist list` | List profiles, mark the active one with `*`. |
| `/modlist status` | Show the active profile, addon packages, configured packages, and config paths. |

## Configuration

Global config: `~/.pi/agent/modlist.json`
Project override: `.pi/modlist.json` (trusted projects only)

```json
{
  "default": "none",
  "profiles": {
    "none": [],
    "research": [
      "npm:pi-usage-extension",
      "npm:pi-cline"
    ],
    "debug": [
      "npm:pi-kilocode"
    ]
  }
}
```

Each profile is a plain array of addon package strings — the same format as the `packages` array in settings.json. Project profiles override global profiles with the same name; `project.default` overrides `global.default`.

## Switching

When you switch to a profile, modlist:

1. Reads the current `packages` from `~/.pi/agent/settings.json`.
2. Unions the profile's addons onto that baseline (deduped, self-package preserved).
3. Shows the diff (added/removed vs current) and asks for confirmation.
4. Atomically rewrites only the `packages` field of `settings.json` (other fields untouched, file permissions preserved).
5. Calls `ctx.reload()` so the new package set takes effect.

Switching to `none` means "no addons" — settings.json packages are unchanged.

## Safety guarantees

- Settings.json packages are never removed by a profile switch.
- Other settings.json fields (provider, model, retry, theme, etc.) are never touched.
- The modlist package itself is always preserved.
- All JSON writes are atomic and preserve file permissions.
- A malformed profile simply doesn't parse — settings.json stays intact.