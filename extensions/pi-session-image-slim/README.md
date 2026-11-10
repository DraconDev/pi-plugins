# pi-session-image-slim

Keeps Pi session transcripts free of inline base64 image payloads.

## Why

Pi persists tool results verbatim in the session JSONL. The `read` tool embeds
images as base64, so a session that looks at a few hundred screenshots grows to
hundreds of megabytes of binary noise. Two costs follow:

- **Disk** — the session store grows far faster than the actual work in it.
- **RAM** — Pi loads the whole transcript into memory as parsed objects when a
  session is resumed (`loadEntriesFromFile` in `session-manager.js`), and
  compaction does not remove the original entries, so the base64 stays resident
  for the life of the process.

On this machine, 49% of the session store (675 MB across 1090 payloads) was
inline image data read from disk.

## What it does

Every image content item in a tool result is replaced with a short text marker:

```text
[image stripped from transcript: 2.7 MB base64 image/png - re-read /home/user/Pictures/shot.png]
```

The marker names the file the image came from, so the transcript stays
actionable — the model can re-read the original when it still matters.

## Two paths

| Path | What it covers |
| --- | --- |
| Extension (`index.ts`) | The session Pi is running: rewritten after the agent settles, so the store cannot re-inflate. |
| CLI (`strip.ts`) | Every transcript under a directory, e.g. for a one-off sweep of the whole store. |

The extension never touches what the model sees during a turn: it rewrites the
stored file only, and the running process keeps the image in its in-memory
context. The saving shows up the next time the session is resumed.

## Safety

- Only files untouched for 30 seconds are rewritten, so a live session is never
  raced.
- The file is re-checked for size and mtime after reading; if it changed
  meanwhile the rewrite is skipped and retried later.
- Writes go to a temporary file and are renamed into place.
- The original mtime is preserved, so the retention policy keeps seeing the
  real age of a session instead of restarting the clock.
- Every rewritten line is still valid JSON.

## Install

```bash
pi install /home/dracon/Dev/pi-plugins/extensions/pi-session-image-slim
```

Then restart Pi or run `/reload`.

## Sweep the whole store by hand

```bash
bun /home/dracon/Dev/pi-plugins/extensions/pi-session-image-slim/strip.ts \
    /home/dracon/.pi/agent/sessions
```
