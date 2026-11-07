# pi-chrome-always

> Always-on Chrome bridge for Pi: persistent loopback daemon (`127.0.0.1:17318`) + indefinite auto-auth + forked companion extension with broad permissions and keepalive.

Pairs with upstream **[pi-chrome](https://pi.dev/packages/pi-chrome)** (the `chrome_*` tab/input layer, kept as-is). This package is the persistence + permissions layer around it. User choices baked in: **systemd daemon**, **max-useful permissions**, **background focus default**, **scaffold now**.

## What it does

| Layer | Upstream pi-chrome | pi-chrome-always |
|---|---|---|
| Bridge lifetime | Dies when the Pi session that first bound `17318` exits (later sessions become clients, and self-heal by re-binding). | systemd user service keeps a wire-compatible bridge on `17318` even when Pi exits; Pi sessions run as clients forwarding via `POST /command`. Takes over the port automatically when a Pi session releases it (5s retry). |
| Auth | `/chrome authorize` (15m default, up to `indefinite`); lock on `/chrome revoke`. | Indefinite auto-auth on every Pi start (same `globalThis` mechanism as `pi-chrome-auto-auth`) + cold-start tool-race fix. `/chrome revoke` still locks until next `/reload` or Pi exit. |
| Companion extension | `tabs, tabGroups, scripting, storage, activeTab, alarms, webNavigation, debugger` + `<all_urls>`, `http://127.0.0.1:17318/*`; polls `/next`, alarms keepalive 0.5m, auto-`reload()` on version drift. | Forked, renamed **Pi Chrome Connector — Always (v0.1.0)**: adds `cookies, bookmarks, history, downloads, management, notifications, desktopCapture`; offscreen keepalive document; version-drift is warn-only (no `reload()` loop with upstream `0.15.x`). |
| Browser data tools | None (no cookie/bookmark/history/downloads API). | `chrome_always_data` tool: `data.cookies.list/get`, `data.bookmarks.tree`, `data.history.search`, `data.downloads.list`, `data.extensions.list` (bridge `data.*` actions). |
| Focus | Background on by default (`backgroundDefault=true`, module-local). | Kept: background on. Watch mode via `/chrome background off`. |

## Install

```bash
# 1. Stage daemon + systemd unit + extension copy
./extensions/pi-chrome-always/install.sh

# 2. Load this Pi package FIRST (must precede pi-chrome)
pi install /home/dracon/Dev/pi-plugins/extensions/pi-chrome-always
pi install npm:pi-chrome   # if not already installed
```

Then in Pi: `/reload` (you should see `pi-chrome-always: auto-auth (indefinite) …`).

In Chrome (your normal, signed-in profile):

```text
chrome://extensions
  → enable Developer mode (top-right)
  → Load unpacked → ~/.local/share/pi-chrome-always/browser-extension
```

Verify:

```bash
curl -s http://127.0.0.1:17318/status
systemctl --user status pi-chrome-always --no-pager
./extensions/pi-chrome-always/scripts/doctor.sh
```

In Pi: `/chrome-always doctor` and `/chrome doctor`.

## Commands

```text
/chrome-always status                 daemon + extension + auth snapshot
/chrome-always doctor                 full health check (bridge, systemd, extension, limits)
/chrome-always daemon start|stop|restart
/chrome-always background             focus policy info (background on by default)
```

Tool: `chrome_always_data` (cookies/bookmarks/history/downloads/extensions).

## Architecture

```text
Chrome (real profile)                    Host (loopback only)
┌─────────────────────────┐   GET /next    ┌─────────────────────┐   POST /command   ┌──────────────┐
│ Always extension        │ ─────────────▶ │ pi-chrome-always    │ ◀─────────────── │ Pi session   │
│ (MV3 service worker +   │ ◀───────────── │ daemon (systemd)    │ ───────────────▶ │ (pi-chrome   │
│  offscreen keepalive)   │   POST /result │ 127.0.0.1:17318     │   client mode    │  client)     │
└─────────────────────────┘                └─────────────────────┘                 ┌──────────────┐
                                                                                   │ OpenCode /   │
                                                                                   │ other local  │
                                                                                   │ tools (opt)  │
                                                                                   └──────────────┘
```

- Daemon implements the same `/status`, `/command`, `/next`, `/result` protocol as pi-chrome's in-Pi server, so upstream clients and the forked extension connect unchanged.
- Extension polls `/next` (long-poll, 25s), drains queued commands, posts `/result`. Alarms (0.5m) + offscreen ping (30s) + `onStartup`/`onInstalled` re-arm polling after MV3 suspension.
- Bridge gates: `/command` is local-process only (`!Origin && !Sec-Fetch-Site`); `/next`/`/result` require `chrome-extension://` origin or `Sec-Fetch-Site: none/same-origin`. No telemetry; nothing leaves the machine.

## Permissions (what "full" actually means)

Fork manifest (`browser-extension/manifest.json`):

```json
{
  "permissions": ["tabs","tabGroups","scripting","storage","activeTab","alarms","webNavigation","debugger",
    "cookies","bookmarks","history","downloads","management","notifications","desktopCapture"],
  "host_permissions": ["<all_urls>", "http://127.0.0.1:17318/*"]
}
```

`cookies` + `history` can read session cookies and browsing history; treat the extension like a trusted local password manager. Wire `data.*` actions are only reachable through the loopback bridge + the `chrome_always_data` Pi tool.

Optional token auth (off by default for pi-chrome client compatibility): `~/.local/share/pi-chrome-always/token` (`0600`) is generated by `install.sh`; the Pi extension sends `X-Pi-Chrome-Token` when the file exists. The daemon enforces it only when `PI_CHROME_ALWAYS_TOKEN` is set in the systemd unit. Enforcing breaks upstream pi-chrome clients (they send no token) — enabling it is an explicit opt-in, documented in `install.sh` output.

## Honest limits (not bridge bugs)

- **No Chrome, no control.** The extension runs inside Chrome; if Chrome is closed, the bridge queues commands that time out. (Chrome autostart is your session autostart, not this package's job.)
- **No privileged Chrome surfaces:** `chrome://` pages, Web Store, password-manager prompts, native file/permission dialogs, CAPTCHA/bot challenges, passkeys/biometrics — Chrome sandbox boundaries, not missing permissions.
- **Cross-origin iframe DOM** via scripting is limited; snapshot/evaluate run via CDP `Runtime.evaluate` and bypass page CSP, screenshots + coordinate input remain the fallback.
- **Any local process running as you** can `POST /command` when token auth is off (loopback trust, same as upstream). For a hostile-local-process threat model, run Pi on a separate user account or enable token auth and patch clients.
- **One port, one owner.** First binder owns `17318`; others become clients. The daemon retries takeover every 5s; Pi sessions self-heal by re-binding (upstream logic).

## Disable / remove

```bash
systemctl --user stop pi-chrome-always
systemctl --user disable pi-chrome-always
rm ~/.config/systemd/user/pi-chrome-always.service
# In Pi: /chrome revoke, then remove this package from ~/.pi/agent/settings.json packages and /reload
# In Chrome: chrome://extensions → Remove "Pi Chrome Connector — Always"
```

## License

MIT (upstream pi-chrome is MIT; fork files carry the same license).
