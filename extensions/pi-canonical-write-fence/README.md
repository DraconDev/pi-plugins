# Canonical metadata writer prototype (NOT enabled)

This is an incomplete source integration, not a deployed safety boundary.
There is deliberately no `index.js` registration yet. Do not add the package to
live settings until the remaining coverage and runtime qualification pass.

`client.js` starts an owned Warden `write-fence` family; request content travels
on stdin, not argv. `worker.js` requires the actual inherited locked descriptor
and checks its repository namespace before any target lookup/SDK mutation queue.
It runs the host SDK's complete edit/write operation, substituting atomic
publication for writes to direct `.gitignore` / `.gitattributes` targets.
Native exact-match edits, BOM/CRLF, Unicode and diff results are retained.

`atomic.js` writes and syncs private scratch before rename. Scratch is anchored
to an open directory descriptor so namespace replacement cannot redirect
cleanup into a newly substituted directory. Ordinary failures/cancellation
remove only the owned temporary inode; unexpected entries are not reaped.
Private scratch has a 32-MiB/64-file recovery ceiling and each request has a
16-MiB limit. SIGKILL recovery remains private, and exhausting the ceiling
refuses further mutations rather than deleting recovery. Cross-device rename
fails closed, never falls back to truncating the target.

## Current qualification

Run with the precise qualified Warden binary and host SDK, not an arbitrary
installed binary lacking the protocol:

```sh
PI_CANONICAL_TEST_WARDEN=/path/to/qualified/target/debug/dracon-warden \
PI_CANONICAL_TEST_SDK=file:///path/to/pi-coding-agent/dist/index.js \
node --test test/*.test.mjs
```

Ten controls pass with zero failures/skips. They include real SDK execution in
disposable Git repositories and a refusal without a held descriptor. The
namespace cleanup regression first reproduced deletion of a foreign substituted
entry; the original failure is retained, not relabelled as a successful run.
Exact source/native identities and raw outcomes are in utilities:
`dracon-sync/docs/design/canonical-writer-fence-2026-10-27/pi-worker-controls-v2.json`.

## Not yet qualified / intentionally unsupported

- No extension registration or loaded live-session proof yet; existing sessions
  do not pick up these files automatically.
- Scope is direct named regular metadata targets, not arbitrary symlink aliases,
  shell/native-Git mutations, external editors or detached writers.
- No all-producer canonical-preservation claim. Unknown/uncooperative writers
  remain unsupported negative controls, not successful cooperative coverage.
- Actual SIGKILL/timeout/parent-family schedules, ENOSPC/write/sync faults,
  directory durability, extended ACL/xattr fidelity and linked-worktree/device
  behavior need qualification before deployment. Current tests cover injected
  pre-publication abort and namespace replacement, not all those conditions.
- The host SDK's private path resolver is deliberately bound to the tested host
  revision; registration must feature-check/version-bind it, not assume every
  future SDK has that layout.
