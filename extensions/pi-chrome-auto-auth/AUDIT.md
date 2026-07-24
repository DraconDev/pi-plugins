# pi-chrome-auto-auth — Audit vs pi-chrome

**Date:** 2026-07-24
**pi-chrome version audited:** 0.15.46 (installed) / 0.15.63 (npm)
**Extension version:** 0.1.0

## TL;DR

**Our `pi-chrome-auto-auth` extension is now subsumed by pi-chrome 0.15.46+.** The vendor package added first-class support for the exact behavior we implemented. **Recommendation: uninstall this extension, run `/chrome authorize indefinite` once.**

What we built (pre-0.15.46):
```ts
globalThis["__piChromeProfileBridgeAuth__"] = { until: "indefinite" };
```

What pi-chrome now does natively:
- `/chrome authorize indefinite` (picker item, line 1168; handler line 1096)
- `persistAuth()` writes `{ until: "indefinite" }` to the **same** `globalState[PI_CHROME_AUTH_KEY]` key we write (line 700)
- `chromeAuthorizedUntil` module-local state restored from that key on every `session_start` (line 691)
- Auth survives `/reload` because of `persistAuth()` — the exact durability property our extension claimed as its differentiator

The only thing our extension added was:
1. A one-time install toast (`pi-chrome auto-authenticated (indefinite)`)
2. Belt-and-suspenders `agent_start` re-fire for the cold-start race

## What pi-chrome 0.15.46 actually exposes

### `/chrome` picker subcommands (line 1213)
```
/chrome authorize [15m|30m|<minutes>|indefinite] — allow this Pi session to use chrome_* tools.
/chrome revoke   — lock Chrome control.
/chrome status   — one-line snapshot of connection, auth, and background setting.
/chrome doctor   — full health check.
/chrome onboard  — install the Chrome companion extension.
/chrome background [on|off|status|toggle] — whether pi-chrome runs without focusing Chrome.
```

The picker has "Indefinite" as a first-class option (line 1168). User picks it once and the session is authorized until revoked or Pi exits.

### Auth persistence (the bit that mattered)
```ts
// index.ts:691-702
const persistedAuth = globalState[PI_CHROME_AUTH_KEY];
if (persistedAuth) {
    if (persistedAuth.until === "indefinite" || persistedAuth.until > Date.now()) {
        chromeAuthorizedUntil = persistedAuth.until;
    } else {
        delete globalState[PI_CHROME_AUTH_KEY];
    }
}
const persistAuth = (): void => {
    if (chromeAuthorizedUntil === undefined) delete globalState[PI_CHROME_AUTH_KEY];
    else globalState[PI_CHROME_AUTH_KEY] = { until: chromeAuthorizedUntil };
};
```

This is **exactly the contract** our extension relied on (per its own README, which quotes `index.ts` lines 686–693). The only differences:

| Capability | Our extension | pi-chrome 0.15.46 |
|---|---|---|
| Set `{ until: "indefinite" }` on `globalThis` | ✅ (in `agent_start` / `session_start`) | ✅ (via `/chrome authorize indefinite`) |
| Auth survives `/reload` | ✅ (because we write before pi-chrome reads) | ✅ (via `persistAuth()` in the auth flow) |
| Cold-start race fix | ✅ (we re-fire in `agent_start`) | ✅ (auth restored from `globalState` before tools register; `chromeToolsRegistered` guard prevents double-register) |
| User-visible feedback | Toast on first install | Toast on every `/chrome authorize` invocation |
| Reversible | Edit `index.ts` or remove package | `/chrome revoke` or `15m`/`30m` |

## Cold-start race — re-examined

Our README claimed:
> pi-chrome's `session_start` handler is async (because of `await bridge.start()`) and can race with the first agent turn — chrome_* tools appear registered but not active.

That race description was accurate for pi-chrome ≤ 0.15.27 (the version we had installed). The 0.15.46 `session_start` (line 912) restores `chromeAuthorizedUntil` from `globalState` **before** registering tools, then activates them synchronously. So:

- If auth is persisted (which `/chrome authorize indefinite` does), there's no race.
- If auth is not persisted, the user has to `/chrome authorize` before any tool call — which is the correct, intended UX.

Our `agent_start` belt-and-suspenders fix is harmless when auth is persisted (it sees tools already active and does nothing) and slightly harmful when auth is missing (it would force-activate tools the user never authorized). The latter is unlikely in practice but is a real privilege escalation if a future pi-chrome version changes the restore order.

## What we should do

### Recommended action
1. **Uninstall `pi-chrome-auto-auth`** from `~/.pi/agent/settings.json` packages list.
2. **Run `/chrome authorize indefinite`** once per fresh Pi session (or set it as a `session_start` script if your workflow demands zero prompts).
3. **Remove the package** from the pi-plugins monorepo (or archive it under `archive/`).

### When our extension would still be useful
- **Pre-0.15.46 environments**: If a user is stuck on pi-chrome ≤ 0.15.27 for some reason, the extension does provide value. Worth noting in the README's "Compatibility" section.
- **Custom auth duration**: Our extension hard-codes `"indefinite"`. pi-chrome's picker offers 15m/30m/custom/indefinite. The vendor approach is strictly more flexible.
- **Cross-package write ordering hack**: Our extension relies on package-load order (it must load before pi-chrome). pi-chrome's native approach removes this fragility entirely.

## Migration path

Before:
```json
{
  "packages": [
    "../../Dev/pi-plugins/extensions/pi-chrome-auto-auth",
    "npm:pi-chrome"
  ]
}
```

After:
```json
{
  "packages": [
    "npm:pi-chrome"
  ]
}
```

Then once per Pi session, run `/chrome authorize indefinite` (or pick "Indefinite" from the picker). The auth persists across `/reload` for the lifetime of that Pi install.

## Evidence

- `pi-chrome/extensions/chrome-profile-bridge/index.ts:691` — auth restore from `globalState[PI_CHROME_AUTH_KEY]`
- `pi-chrome/extensions/chrome-profile-bridge/index.ts:700` — `persistAuth()` writes back
- `pi-chrome/extensions/chrome-profile-bridge/index.ts:1096` — `authorizeHandler` accepts "indefinite" string
- `pi-chrome/extensions/chrome-profile-bridge/index.ts:1168` — "Indefinite" picker menu item
- `pi-chrome/extensions/chrome-profile-bridge/index.ts:1213` — `/chrome` command help text
- `pi-chrome/CHANGELOG.md` — 0.15.x line: "persistAuth() syncs state back to globalThis, so the auth survives /reload"
- Live test (this session): extension removed from load order, `/chrome authorize indefinite` works, all 19 chrome_* tools usable from first turn.

## Conclusion

The vendor caught up. Our extension's behavior is now a strict subset of pi-chrome's built-in `/chrome authorize indefinite` + `persistAuth()`. Keep the extension only as a fallback for legacy pi-chrome versions; otherwise delete it.
