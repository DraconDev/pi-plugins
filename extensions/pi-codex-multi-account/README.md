# pi-codex-multi-account

Runs several ChatGPT accounts side by side in pi.

Pi stores credentials per provider id in `~/.pi/agent/auth.json`, so the built-in
`openai-codex` provider is a **single slot**: every `/login openai-codex`
replaces the previous account. This extension registers extra slots
(`codex-owner`, `codex-seat2`, …) that use the same ChatGPT OAuth flow, each with
its own stored credential, so all accounts are signed in at once and appear in
the model picker.

## Slots

Default slots: `codex-owner`, `codex-seat2`, `codex-seat3`, `codex-seat4`,
`codex-seat5`. Override them in `~/.pi/agent/codex-multi-account.json`:

```json
{
  "accounts": [
    { "id": "codex-owner", "label": "Business seat 1 (owner)" },
    { "id": "codex-seat2", "label": "Business seat 2" }
  ]
}
```

## Usage

```
/login codex-seat2      # browser or device-code login; pick the workspace
/codex-accounts         # slot -> signed in / email / plan
```

Models per slot mirror pi's `openai-codex` catalog (GPT-6.2 Astra/Sol down to
GPT-5.6 Luna) — `models.json` in this directory.

## Headless login

```
node scripts/login.ts codex-seat2            # browser flow
node scripts/login.ts codex-seat2 --device   # device code flow
```

Writes the credential straight into `~/.pi/agent/auth.json` under the slot id.
Start pi (or `/reload`) afterwards to pick it up.

## Notes

- The browser flow listens on `127.0.0.1:1455` (the same port the Codex CLI
  uses). If the port is busy, paste the full redirect URL instead.
- Each slot keeps its own ChatGPT account; the workspace you pick at login is
  the one whose quota the slot spends.
- See `SEATS.md` for the workspace runbook (seat assignment, billing cliff).
