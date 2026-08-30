# pi-session-retention

Pi does not automatically expire the JSONL files shown by `/resume`. This extension keeps that history manageable without loading every transcript into memory.

On fresh Pi startup it scans the default `~/.pi/agent/sessions/` store and quarantines sessions that are:

- older than 30 days;
- beyond the newest 10 sessions for a project and at least 7 days old; or
- tiny (16 KiB or less) and at least 7 days old, which catches abandoned/header-only runs.

The newest/recent sessions are protected, the current session is protected, names found in the bounded session slices are protected, and fork parents of retained sessions are protected. The extension only runs automatically for `session_start` with reason `startup`, so `/reload` and `/new` do not repeatedly rescan the store.

Pi processes that have loaded the extension also register a small PID marker under `~/.pi/agent/.session-retention-active/`; live marker entries protect their session files during cleanup. Stale markers are ignored and removed on a later scan.

## Recovery model

Matches are moved, not immediately deleted, to:

```text
~/.pi/agent/session-retention-quarantine/<run-id>/
```

They are no longer loadable by `/resume`, but each run has a `manifest.jsonl` and can be restored with:

```text
/session-retention status
/session-retention cleanup --dry-run
/session-retention restore <run-id>
```

Quarantine runs older than 14 days are permanently purged on the next automatic cleanup. Change that window with `PI_SESSION_RETENTION_QUARANTINE_DAYS` or set a large value if you need a longer recovery window.

## Configuration

All values are optional environment variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_SESSION_RETENTION_MAX_AGE_DAYS` | `30` | Age at which a session becomes eligible regardless of project rank |
| `PI_SESSION_RETENTION_KEEP_PER_PROJECT` | `10` | Newest sessions kept per encoded project directory |
| `PI_SESSION_RETENTION_CAP_AFTER_DAYS` | `7` | Minimum age for the per-project cap |
| `PI_SESSION_RETENTION_PROTECT_RECENT_DAYS` | `2` | Never touch sessions newer than this, including other live Pi processes |
| `PI_SESSION_RETENTION_TINY_BYTES` | `16384` | Size threshold for abandoned-session cleanup |
| `PI_SESSION_RETENTION_TINY_AFTER_DAYS` | `7` | Minimum age for tiny-session cleanup |
| `PI_SESSION_RETENTION_QUARANTINE_DAYS` | `14` | How long quarantined runs remain recoverable |
| `PI_SESSION_RETENTION_AUTO` | `true` | Set to `0`/`false` to disable startup cleanup |
| `PI_SESSION_RETENTION_DRY_RUN` | `false` | Plan cleanup without moving files |
| `PI_SESSION_RETENTION_PROTECT` | empty | Comma-separated path/project fragments to always protect |

The default session store can also be redirected with Pi's existing `PI_CODING_AGENT_DIR` variable.

Install this local package with:

```bash
pi install /home/dracon/Dev/pi-plugins/extensions/pi-session-retention
```

Then restart Pi or run `/reload`.
