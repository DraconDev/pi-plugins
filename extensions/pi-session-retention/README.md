# pi-session-retention

Pi does not automatically expire the JSONL files shown by `/resume`. This extension keeps that history manageable without loading every transcript into memory.

On fresh Pi startup it scans the default `~/.pi/agent/sessions/` store and removes sessions that are:

- older than 30 days;
- beyond the newest 10 sessions for a project and at least 7 days old; or
- tiny (16 KiB or less) and at least 7 days old, which catches abandoned/header-only runs.

The newest/recent sessions are protected, the current session is protected, sessions named
explicitly by the user are protected, and fork parents of retained sessions are protected. The
extension only runs automatically for `session_start` with reason `startup`, so `/reload` and
`/new` do not repeatedly rescan the store.

Pi processes that have loaded the extension also register a small PID marker under
`~/.pi/agent/.session-retention-active/`; live marker entries protect their session files during
cleanup. Stale markers are ignored and removed on a later scan.

## What counts as a session

The store is not flat. Besides the top-level `sessions/<project>/<session>.jsonl` files that
`/resume` lists, a session directory can hold nested artifacts:

```text
sessions/<project>/<session>.jsonl              # top-level session
sessions/<project>/<session-id>/forks/*.jsonl    # fork branches
sessions/<project>/<session-id>/<run>/run-N/     # subagent run transcripts
sessions/<project>/subagent-artifacts/           # subagent artifacts
```

All of them are scanned. Nested artifacts are governed by age only — they never compete for the
per-project keep slots, because Pi's own session browser does not list them either.

## Name protection

A session is kept forever only when the name was chosen on purpose:

| Session | Kept? |
| --- | --- |
| `"my important audit session"` (set with `/name`) | yes |
| `"general-purpose#36442bff"` (pi-subagents auto-label) | no |
| `"subagent-scout-88e98f95-cf4f-…-1"` (pi-subagents auto-label) | no |
| a session whose system prompt starts with `<active_agent name="…"/>` | no |

Machine-generated subagent labels used to exempt thousands of sessions from cleanup, which made
the policy a no-op. The extension now detects those labels and the `<active_agent>` marker that
pi-subagents injects into every child session, and only an explicit user choice protects a
session.

## Recovery model

By default matches are moved, not immediately deleted, to:

```text
~/.pi/agent/session-retention-quarantine/<run-id>/
```

They are no longer loadable by `/resume`, but each run has a `manifest.jsonl` and can be restored with:

```text
/session-retention status
/session-retention cleanup --dry-run
/session-retention restore <run-id>
```

Quarantine runs older than 14 days are permanently purged. The Pi startup hook performs this purge
as a fallback, and the optional user timer below checks every six hours even when Pi is closed.
Change that window with `PI_SESSION_RETENTION_QUARANTINE_DAYS` or set a large value if you need a
longer recovery window.

With `"delete": true` in the policy file the extension skips quarantine entirely and unlinks
matching files. There is no manifest and no recovery in that mode.

## Configuration

All values are optional environment variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_SESSION_RETENTION_MAX_AGE_DAYS` | `30` | Age at which a session becomes eligible regardless of project rank |
| `PI_SESSION_RETENTION_KEEP_PER_PROJECT` | `10` | Newest sessions kept per encoded project directory |
| `PI_SESSION_RETENTION_CAP_AFTER_DAYS` | `7` | Minimum age for the per-project cap |
| `PI_SESSION_RETENTION_PROTECT_RECENT_DAYS` | `2` | Never touch anything newer than this, including other live Pi processes |
| `PI_SESSION_RETENTION_TINY_BYTES` | `16384` | Size threshold for abandoned-session cleanup |
| `PI_SESSION_RETENTION_TINY_AFTER_DAYS` | `7` | Minimum age for tiny-session cleanup |
| `PI_SESSION_RETENTION_QUARANTINE_DAYS` | `14` | How long quarantined runs remain recoverable |
| `PI_SESSION_RETENTION_DELETE` | `false` | Delete matching sessions outright instead of quarantining them |
| `PI_SESSION_RETENTION_AUTO` | `true` | Set to `0`/`false` to disable startup cleanup |
| `PI_SESSION_RETENTION_DRY_RUN` | `false` | Plan cleanup without moving files |
| `PI_SESSION_RETENTION_PROTECT` | empty | Comma-separated path/project fragments to always protect |

### Policy file

The environment is not a reliable configuration channel: Pi is started from terminals, from the
systemd timer and from IDEs, and they do not share an environment. The extension therefore also
reads a policy file next to the session store:

```text
~/.pi/agent/session-retention.json
```

```json
{
  "maxAgeDays": 7,
  "keepPerProject": 10,
  "capAfterDays": 7,
  "protectRecentDays": 2,
  "tinyBytes": 16384,
  "tinyAfterDays": 7,
  "quarantineDays": 0,
  "delete": true,
  "protect": []
}
```

Precedence is: explicit command-line overrides → policy file → environment variables → defaults.
The `protect` array holds extra path/project fragments that are always kept.

The default session store can also be redirected with Pi's existing `PI_CODING_AGENT_DIR` variable.

Install this local package with:

```bash
pi install /home/dracon/Dev/pi-plugins/extensions/pi-session-retention
```

Then restart Pi or run `/reload`.

## Automatic expiry timer

Install the optional timer once to enforce the policy independently of Pi:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/pi-session-retention-purge.service systemd/pi-session-retention-purge.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-session-retention-purge.timer
```

It runs shortly after the user systemd session starts and then every six hours. It purges expired
quarantine runs and applies the full cleanup policy, so sessions are still expired while Pi is
closed. The supplied unit assumes this checkout remains at `~/Dev/pi-plugins` and Bun remains at
`~/.bun/bin/bun`.
