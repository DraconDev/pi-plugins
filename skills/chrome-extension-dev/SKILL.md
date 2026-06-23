---
name: chrome-extension-dev
description: Load, reload, and manage unpacked Chrome extensions in the user's signed-in Chrome while developing or debugging them. Use when the user says things like "load this unpacked extension", "reload the extension after my edit", "what extensions are installed", "unload this extension", "test my Chrome extension", or "auto-load the unpacked folder". Bridges the gap that Chrome's "Load unpacked" button opens a native GTK file picker that DOM automation (chrome_click, chrome_upload_file) cannot drive. The skill drives the picker via xdotool through XWayland, packs extensions to CRX as a fallback, and provides reload/inspect/unload workflows using the chrome_* tools.
---

# Chrome Extension Dev

Load, reload, and manage unpacked Chrome extensions in the user's signed-in Chrome for development and testing. Assumes:

- `pi-chrome` is installed and authorized (the `pi-chrome-auto-auth` extension can pre-set this on every Pi session).
- The Pi Chrome Connector companion is loaded in the user's Chrome profile.
- The user is on a Wayland session with `xdotool` available through XWayland (this is true on the current host: `xdotool getactivewindow` returns a real ID via `DISPLAY=:0`).

If any of those aren't true, the user needs to run `/chrome authorize` (or install the companion) first; do not block on those.

## Choose a path

| Path | When to use it | Fully automatic? | Robust? |
|---|---|---|---|
| **A. xdotool-driven native picker** | Default. Any unpacked extension folder on the local filesystem. | Yes | Mostly (depends on GTK picker focus) |
| **B. Pack to CRX, install via chrome.management** | Path A is flaky and a "loader" companion is installed (currently NOT). | Yes | Very |
| **C. Pack to CRX, user drops in chrome://extensions** | Quickest when the user is at the keyboard. | No (one drag) | Bulletproof |
| **D. Manual DOM steps + user clicks picker** | xdotool is missing or fails. | No | Bulletproof |

Try A first. Fall back to B if a loader companion exists. Fall back to C if A is failing. Fall back to D if A keeps failing and the user is OK driving the picker themselves.

---

## Path A — xdotool-driven native picker (default)

### Procedure

1. **Pre-flight via `chrome_evaluate`** on the active tab:
   ```js
   // Check what extensions are already loaded
   await chrome.management.getAll().then(es => es.filter(e => e.type === 'extension').map(e => ({id: e.id, name: e.name, enabled: e.enabled})))
   ```
2. **Navigate to `chrome://extensions`**:
   ```js
   chrome_navigate({ url: "chrome://extensions" })
   ```
3. **Click the Developer mode toggle** at the top right (if not already on):
   ```js
   chrome_click({ uid: "<developer-mode-toggle>" })
   ```
4. **Click the "Load unpacked" button** (visible only when Developer mode is on):
   ```js
   chrome_click({ uid: "<load-unpacked-button>" })
   ```
5. The GTK file picker opens. **Hand off to the helper script**:
   ```bash
   ./scripts/load-via-xdotool.sh /absolute/path/to/extension
   ```
   The script:
   - Waits for the picker window to appear (polls `xdotool search --name 'Open Folder'` or `--class 'Chrome*'` with `--name '*Select*'`)
   - `xdotool type --delay 30 /absolute/path/to/extension`
   - `xdotool key Return` (or clicks the "Open" button via window-tree search)
   - Returns non-zero if the picker never appears within 5 s
6. **Verify** by calling `chrome.management.getAll()` again (same expression as step 1) and looking for the new extension by name.

### Failure modes and what to do

- **Picker window never appears**: probably the Load unpacked click missed. Take a fresh `chrome_snapshot` to find the new uid, click it again, and retry the helper.
- **`xdotool type` goes to the wrong window**: focus the picker first with `xdotool windowfocus <winid>`, then `type` (or use `--window`).
- **Extension is rejected with "Manifest file is missing or unreadable"**: the path is wrong or the folder is a subdir. Verify with `ls /absolute/path/to/extension/manifest.json` before retrying.
- **Extension is rejected with "This extension is not from a recognized source"**: nothing to do; tell the user.

---

## Path B — Pack to CRX + chrome.management.install

Requires a "loader" companion extension in the user's Chrome profile with the `management` permission and a small message handler. The current `Pi Chrome Connector` does **not** have this permission, so Path B is **not** available out of the box.

If a loader is installed:

1. Pack the extension:
   ```bash
   ./scripts/pack-to-crx.sh /absolute/path/to/extension
   ```
   This runs `google-chrome-stable --pack-extension=<path>` and prints the CRX path.
2. Have the loader install it (the loader exposes this; the exact call depends on its API). For a minimal loader that listens on a port, the AI would `curl` the loader's install endpoint with the CRX path.

The loader companion would be a 30-line Chrome extension with:
```json
"permissions": ["management", "tabs"]
```
and a service worker that handles `chrome.runtime.onMessage` for `{type: 'install', url: 'file:///path/to/extension.crx'}` by calling `chrome.management.install({url})`.

This is a follow-up project; do not build it ad-hoc.

---

## Path C — Pack to CRX + user drops it

Same as B step 1, then ask the user to:
1. Open `chrome://extensions` (Developer mode on)
2. Drag the CRX file from the path the script printed onto the page

The AI does the rest (verify with `chrome.management.getAll()`).

---

## Path D — Manual fallback

If xdotool is missing, fails repeatedly, or the picker is portal-backed and unreachable:

1. Do Path A steps 1–4 (DOM steps via chrome_* tools).
2. Tell the user: "Native file picker is open. Navigate to `/absolute/path/to/extension` and click Open."
3. Wait for the user to confirm, then verify with `chrome.management.getAll()`.

---

## After the extension is loaded: reload, inspect, unload

All of these go through `chrome_evaluate` on any regular web page (or the chrome://extensions page itself).

### Reload an extension after editing source files

```js
// Given the extension id (find it first via chrome.management.getAll)
await chrome.management.reload('<EXTENSION_ID>')
```

The `chrome.management.reload` API is only available to extensions with the `management` permission. The Pi Chrome Connector does not have it, so this call would fail from a regular page. Workaround: navigate to `chrome://extensions`, find the extension's card, click its "Reload" button via `chrome_click`.

### Inspect what's installed

```js
await chrome.management.getAll()
  .then(es => es
    .filter(e => e.type === 'extension')
    .map(({id, name, version, enabled, installType, homepageUrl}) =>
      ({id, name, version, enabled, installType, homepageUrl})))
```

Returns objects you can filter by `installType === 'development'` to find unpacked extensions.

### Unload (remove) an unpacked extension

DOM path: navigate to `chrome://extensions`, find the card, click "Remove" → confirm.

Programmatic path: requires `management` permission (Path B territory). If no loader is installed, use the DOM path.

### Toggle Developer mode

DOM path: navigate to `chrome://extensions`, click the toggle at top right. State persists across sessions.

---

## Helper scripts

All scripts are in `scripts/`. They print clear errors and exit non-zero on failure so the AI can branch on `$?`.

| Script | Purpose |
|---|---|
| `scripts/load-via-xdotool.sh <ext-path>` | Drives the GTK file picker with xdotool to load an unpacked extension |
| `scripts/pack-to-crx.sh <ext-path>` | Packs an unpacked extension to a CRX using google-chrome-stable |
| `scripts/find-extension-id.sh <ext-path>` | Computes the Chrome extension ID for a given path (via the public key in the manifest's "key" field, or by hashing the path) — useful for reloading after edits |
| `scripts/verify-loaded.sh <expected-name-or-id>` | Polls `chrome.management.getAll()` via a small CDP probe and exits 0 when the extension is present |

`scripts/load-via-xdotool.sh` is the only one that requires a real X server (it uses `xdotool`).

See `references/wayland-picker-notes.md` for details on why xdotool works (XWayland) and what to do if it stops working.
