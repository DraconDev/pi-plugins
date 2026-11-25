# Day-to-day guide

Everything below is already set up and running. Two layers, one mental model.

## The two layers

| | **Pool** (codex-lb) | **Direct slots** (pi) |
|---|---|---|
| What | Local proxy that picks an account for each request | One provider per account, straight to OpenAI |
| Reached by | plain `codex`, and pi's `codex-pool` provider | pi's `codex-owner`, `codex-seat2`… providers |
| Account choice | automatic (capacity weighted) | you choose, per task |
| Good for | "just do the work" | "run this on seat 3", per-account attribution |
| If the proxy dies | n/a | still works |

Nothing is shared between accounts beyond the pool's routing decision.

## Just work

```bash
codex                       # pool picks the account with the most quota left
cd project && codex         # same, in a project
```

The pool routes per request, keeps a session on one account so the prompt cache
stays warm, and moves off an account that hits its limit. You never pick one.

## Work on one specific seat

```bash
cxacct seat3                # codex, pinned to seat3's account (bypasses the pool)
cxacct seat3 exec "fix the failing test"
```

In pi, switch the model to that account's slot:

```
/model codex-seat3/gpt-6.2-sol
```

## Run one task on every account at once

In pi:

```
/fanout fix the flaky auth test
```

One parallel worker per signed-in account, each pinned to a different account,
so each spends a different quota pool. Results come back as a table tagged by
account. `/codex-accounts` shows which slots are signed in right now.

## See where the quota is

```bash
cxacct pool                 # every account: status, plan, 5h + weekly reset times
cxacct list                 # every account: email, plan, account id
```

Dashboard (nicer, clickable): **http://127.0.0.1:2455**

Inside pi: `/codex-accounts` — slots and pool side by side.

Inside codex: `/usage` shows the active account's allowance.

## Your accounts today

| Alias | Email | Plan | Pool |
|---|---|---|---|
| `business-seat1 (owner)` | adamnadrac@gmail.com | Business seat | 5h resets 04:08, weekly Dec 1 |
| `personal-plus (gmail)` | adamnadrac@gmail.com | ChatGPT Plus (personal workspace of the same address) | 5h resets 08:04, weekly Nov 30 |
| `personal-plus (dracon.uk)` | adam@dracon.uk | ChatGPT Plus | 5h resets 05:32, weekly Nov 30 |

Three independent pools, and they count separately — the Business seat and the
personal Plus plan of the same email are different subscriptions with different
allowances.

pi slots: `codex-owner` (Business seat), `codex-personal` (Plus, gmail),
`openai-codex` (Plus, dracon.uk — pi's built-in provider), plus `codex-seat2`
… `codex-seat5` as they land. `codex-pool` is the whole pool as one provider.

A note on the dashboard: the same email can appear twice (a personal workspace
and a Business workspace under one address). That is why every pool account has
an **alias** — set them from Accounts → account → Details, or:
`curl -X PUT http://127.0.0.1:2455/api/accounts/<id>/alias -d '{"alias":"..."}'`.

## Adding a seat

```bash
cxacct login seat4          # sign that account in
cxacct import seat4         # add it to the pool
```

Then in pi: `/login codex-seat4` to give it a direct slot too.

## When something breaks

| Symptom | Cause / fix |
|---|---|
| `codex` errors, "connection refused" | The pool is down: `systemctl --user status codex-lb`, `systemctl --user restart codex-lb`. Or bypass it: `cxacct owner` |
| One account always errors in pi | That slot's token expired: `/login codex-owner` again |
| "no API key found for codex-seatN" | Slot never signed in: `/login codex-seatN` |
| Pool routes to the wrong account | Dashboard → Settings → Routing → pick a strategy (capacity weighted is the default) |
| Want to pin the pool to one account | Dashboard → Settings → Routing → **Single account**, or `cxacct <name>` |
| Proxy works but models 404 | The account's plan doesn't have that model — check `cxacct pool` for `plan:` |

## Settings worth knowing (dashboard → Settings)

- **Routing strategy** — capacity weighted (default), round robin, fill first,
  sequential drain, reset drain, single account. Changes apply live.
- **Sticky threads** — keep a session on one account (warm prompt cache).
- **Prefer earlier reset** — use the account whose window resets soonest.
- **Quota planner** — weekly pace across accounts.
- **Request logs** — what was sent, to which account, with what error.

## Upstream docs

- codex-lb: https://soju06.github.io/codex-lb/ (routing, deployment, troubleshooting)
- Codex CLI auth: `codex login --help`, `codex doctor`
- pi extension: `README.md` in this directory

## Files that matter

| Path | What |
|---|---|
| `~/.codex/config.toml` | Codex CLI now points at the pool (`model_provider = "codex-lb"`) |
| `~/.codex-account-<name>/` | One home per account (auth + config), shares sessions with `~/.codex` |
| `~/.config/codex-lb/api.key` | Pool client key (also in `~/.zshrc` as `CODEX_LB_API_KEY`) |
| `~/.local/share/codex-lb/` | Pool database and encryption key |
| `~/.pi/agent/auth.json` | pi's per-slot OAuth credentials |
| `~/.pi/agent/fallback-router.json` | The failover chain (all accounts) |
| `~/.pi/agent/codex-multi-account.json` | Which pi slots exist |

## If `codex` ever complains about a missing key

`~/.local/bin/codex` is a wrapper that exports the pool key before execing the
real binary (which lives at `~/.codex/packages/standalone/current/bin/codex`).
If `codex update` replaces the wrapper with a symlink again, restore it:

```bash
rm ~/.local/bin/codex && cat > ~/.local/bin/codex <<'SH'
#!/usr/bin/env bash
if [ -z "${CODEX_LB_API_KEY:-}" ] && [ -r "$HOME/.config/codex-lb/api.key" ]; then
  export CODEX_LB_API_KEY="$(cat "$HOME/.config/codex-lb/api.key")"
fi
exec "$HOME/.codex/packages/standalone/current/bin/codex" "$@"
SH
chmod 755 ~/.local/bin/codex
```
