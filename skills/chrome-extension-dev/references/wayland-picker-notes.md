# Wayland picker notes

## Why xdotool works on a Wayland session

This host runs Wayland (`WAYLAND_DISPLAY=wayland-0`, loginctl `Type=wayland`)
but has XWayland providing X11 compatibility for legacy apps. Chromium on
Linux uses the GTK file chooser, which on this host runs as an X client via
XWayland (the system does not have `xdg-desktop-portal` installed — verified
by `command -v xdg-desktop-portal` returning empty). GTK dialogs are real X11
windows on the XWayland display `:0`, and `xdotool` can drive them.

Concretely: `DISPLAY=:0 xdotool getactivewindow` returns a valid window ID
on this host, and `xdotool search --name 'Open'` finds Chromium's
"Open" picker window. So Path A in SKILL.md is viable.

## When it breaks

- **Portal is installed.** If a future NixOS module adds
  `xdg-desktop-portal-gtk` or `-kde`, Chromium will switch to a portal
  chooser that is a separate Wayland surface. `xdotool` will not see it.
  Fall back to Path B (loader companion with `management` permission) or
  Path D (manual).
- **XWayland is disabled.** Rare on NixOS, but if a future config sets
  `services.xserver.enable = false` and doesn't add a portal, native
  dialogs become invisible to xdotool.
- **Chrome is running with `--ozone-platform=wayland` (not XWayland).**
  In that case Chrome is a native Wayland app and the picker is a Wayland
  surface. xdotool cannot see it. Install `ydotool` and write a parallel
  `load-via-ydotool.sh` (similar shape, different input layer).
- **The picker window is not focused.** `xdotool type` goes to whichever
  window has focus. The helper script does `xdotool windowfocus` first,
  but if the window manager rejects the focus request (some compositors
  do for security), the typing will land in the wrong window. Workaround:
  use `xdotool key --window <winid>` to send to a specific window without
  requiring focus.

## Detecting portal vs GTK

```bash
command -v xdg-desktop-portal >/dev/null && echo portal-installed || echo portal-missing
```

If portal is installed, the helper script's picker-search should match on
portal-specific window classes/titles (e.g. `xdg-desktop-portal-gtk`'s
`ChooserDialog`). The default regex in `load-via-xdotool.sh` is loose
(`Open|Select|Choose`) and will often match portal pickers too, so the
script may appear to "work" even when it is actually failing silently.
Always verify with `chrome.management.getAll()` after a load.
