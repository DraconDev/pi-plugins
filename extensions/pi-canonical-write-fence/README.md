# Canonical metadata writer prototype (NOT enabled by this work)

This is an incomplete source integration, not a deployed safety boundary.
`index.js` registers native edit/write definitions and a scope/counter status
command; its registration is exercised through the real Pi loader in disposable
fixtures. No live-session settings were changed. Do not add it to live settings
until the remaining coverage and runtime qualification pass.

`client.js` starts an owned Warden `write-fence` family; request content travels
on stdin, not argv. `worker.js` requires the actual inherited locked descriptor
and checks its repository namespace before any target lookup/SDK mutation queue.
Every typed edit/write in a discovered worktree takes the fence before target
lookup, not merely requests whose basename looks like metadata. After acquiring
it, the worker resolves same-repo aliases and atomically publishes metadata
changes to the canonical regular target while preserving the alias itself.
Cross-repo/unowned aliases, shared-hardlink targets and metadata leaf symlinks
refuse. Ordinary regular worktree files retain in-place write semantics. Outside
repositories, ordinary files stay usable through `outside.js`, which uses
no-follow descriptors and checks regular-file/ownership/link count BEFORE
truncation. Broken/unreadable Git metadata is never an unfenced fallback.
Native exact-match edits, BOM/CRLF, Unicode and diff results are retained for
the qualified cases; this is not yet a general crash-semantics equivalence claim.

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

Nineteen controls pass with zero failures/skips. Added real-loader controls cover
same-repo metadata alias write/edit, alias preservation, cross-repo refusal,
ordinary file inode/mode fidelity, outside-repo plain files and link refusals,
refusal on broken repository ownership metadata, plus ordinary in-place abort
settling to full new bytes with the same inode/mode and fence release. They include actual Pi loader
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
`dracon-sync/docs/design/canonical-writer-fence-2026-10-27/pi-ordinary-cancel-controls.json`.
Earlier alias/cancellation/ENOSPC receipts remain retained.
The receipt hashes the prototype, native fault fixture, qualified Warden binary
and compiled host SDK before/after execution.

## Not yet qualified / intentionally unsupported

- No loaded live-session proof yet; a disposable loader execution is not evidence
  that already-running operator sessions have picked up the extension.
- Scope is typed worktree edit/write, including existing same-repo metadata
  aliases. Cross-repo/unowned/dangling links and hardlinked mutations refuse.
  Shell/native-Git mutations, external editors and detached writers remain open.
- Ordinary abort parity is now qualified: a disposable gate pauses the first
  native ordinary write after open/truncate; client abort lets that write settle
  inside the TERM->KILL grace, reports cancelled/aborted, leaves full new bytes
  (not truncated partial, not silent original) with the same inode/mode, and
  releases the fence. This matches the host SDK settle-before-release contract
  where an abort after write still leaves the completed write. SIGKILL mid-write,
  timeout kills after run deadlines, parent-death and other forced-kill schedules
  remain unqualified and are still a deployment blocker.
- Worktree requests have the existing prototype's 16-MiB transport bound;
  general large-input compatibility has not been established.
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
