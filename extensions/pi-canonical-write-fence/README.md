# Canonical metadata writer prototype (NOT enabled by this work)

This is an incomplete source integration, not a deployed safety boundary.
`index.js` registers native edit/write definitions and a scope/counter status
command; its registration is exercised through the real Pi loader in disposable
fixtures. No live-session settings were changed. Do not add it to live settings
until the remaining coverage and runtime qualification pass.

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

Thirteen controls pass with zero failures/skips. They include actual Pi loader
registration, native schemas/legacy-edit preparation/dynamic-cwd execution and
real SDK transactions in disposable Git repositories. An actual cancellation
schedule pauses the writing family after scratch fsync but before rename:
an independent repository still publishes, cancellation preserves the original
canonical inode/content, private scratch clears, the blocked child exits and
a new native participant reacquires the fence. Refusal without a held descriptor
is tested separately. A disposable native interposer also returns ENOSPC on
actual private scratch write/writev and fsync calls: both stages refuse, preserve
canonical bytes/inode, clear owned scratch and permit native fence reacquisition.
This does not fill the host disk or establish the cause of historical leaks. The
namespace cleanup regression first reproduced deletion of a foreign substituted
entry; the original failure is retained, not relabelled as a successful run.
Exact source/native identities and raw outcomes are in utilities:
`dracon-sync/docs/design/canonical-writer-fence-2026-10-27/pi-io-controls.json`.
The receipt hashes the prototype, native fault fixture, qualified Warden binary
and compiled host SDK before/after execution.

## Not yet qualified / intentionally unsupported

- No loaded live-session proof yet; a disposable loader execution is not evidence
  that already-running operator sessions have picked up the extension.
- Scope is direct named regular metadata targets, not arbitrary symlink aliases,
  shell/native-Git mutations, external editors or detached writers.
- No all-producer canonical-preservation claim. Unknown/uncooperative writers
  remain unsupported negative controls, not successful cooperative coverage.
- SIGKILL/timeout/parent-family schedules, remaining I/O/error stages, directory
  durability, extended ACL/xattr fidelity and linked-worktree/device behavior
  need qualification before deployment. Covered controls include actual
  cooperative cancellation, private scratch write/fsync ENOSPC,
  independent-repo progress, injected pre-publication abort and namespace
  replacement, not all those conditions.
- The host SDK's private path resolver is deliberately bound to the tested host
  revision. Registration feature-checks its function export, but a future SDK
  layout or semantic change still requires fresh qualification.
