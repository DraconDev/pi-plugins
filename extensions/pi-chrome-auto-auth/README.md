# pi-chrome-auto-auth

> Auto-authorizes [pi-chrome](https://pi.dev/packages/pi-chrome) for the lifetime of each Pi session.

A tiny Pi extension (~30 lines) that pre-sets pi-chrome's persistent auth state on `globalThis` before pi-chrome's extension factory reads it. The result: every Pi session starts with `chrome_*` tools already usable — no 15-minute re-authorization prompt, no manual `/chrome authorize` per session.

## What it does

When you start a Pi session, this extension runs before pi-chrome and writes:

```ts
globalThis["__piChromeProfileBridgeAuth__"] = { until: "indefinite" };
```

pi-chrome's factory then reads that key on init (source: `extensions/chrome-profile-bridge/index.ts` lines 686–693) and assigns the value to its module-local `chromeAuthorizedUntil`. The `chrome_*` tools are registered and usable from the first turn.

The only user-visible feedback is a one-time toast on first install:

> `pi-chrome auto-authenticated (indefinite)`

## Install

From a clone of this repo's parent (assumes pi-plugins is at `~/Dev/pi-plugins`):

```bash
pi install /home/dracon/Dev/pi-plugins/extensions/pi-chrome-auto-auth
```

Or, once you have a git remote (the pi-plugins monorepo at
`DraconDev/pi-plugins`), reference the subdir:

```bash
pi install git:github.com/DraconDev/pi-plugins/extensions/pi-chrome-auto-auth@v0.1.0
```

Then in Pi:

```text
/reload
```

You should see the toast above. Any `chrome_*` call (`chrome_tab`, `chrome_navigate`, `chrome_snapshot`, etc.) will work without `/chrome authorize`.

## Security model

This extension does **not** weaken the loopback-bridge trust model:

- The bridge still binds to `127.0.0.1:17318` only — no network exposure.
- The Chrome companion extension still has to be loaded in your browser profile.
- `/chrome revoke` still works to lock tools mid-session (the lock holds until the next `/reload` or Pi exit).
- The next fresh Pi startup will re-assert the indefinite auth.

The only thing this skips is the 15-minute re-authorization prompt. Any new Pi session in your user account can drive your real signed-in Chrome without an explicit gate. If you don't want that, you can:

- Pin the auth to a time limit instead of `"indefinite"` by editing the line `g[PI_CHROME_AUTH_KEY] = { until: "indefinite" };` in `index.ts` to `g[PI_CHROME_AUTH_KEY] = { until: Date.now() + 30 * 60 * 1000 };` (30 minutes).
- Disable the extension for a session by removing it from `settings.json` `packages` and reloading.

## Disabling temporarily

| Want to… | Do this |
|---|---|
| Lock Chrome control right now | `/chrome revoke` |
| Lock for the rest of the session | Edit `index.ts` and `/reload` |
| Disable for all future sessions | Remove the package from `settings.json` `packages` and `/reload` |
| Re-enable | `pi install <path>` and `/reload` |

## License

MIT. See [LICENSE](./LICENSE).
