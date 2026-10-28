# Canonical writer prototype — live deployment NOT qualified

Source integration and disposable qualification only. Do not enable it or lift
publication containment until the unchanged original syscall control passes and
remaining producer/runtime/assembly gates pass.

## Boundary and lifetime

`index.js` acquires the v1 per-worktree fence BEFORE target lookup or host SDK
mutation-queue registration for every typed worktree edit/write. `lease.js`
uses a small Linux N-API bridge (`native/fence.c`) for nonblocking flock and
CLOEXEC descriptor duplication. It interoperates with Warden's persistent owned
0600 single-link lock; it never unlinks, steals or explicitly unlocks an
inherited OFD. Acquisition has a finite absolute deadline and abortable waits.

The COMPLETE native SDK transaction runs in the actual Pi process, holding its
fence until awaited I/O and the SDK queue settle. Caller cancellation does not
force-kill an in-place writing helper. A completed ordinary write can therefore
remain on disk even when the SDK subsequently reports cancellation, exactly as
in the native tool. No detached future write or early fence release is intended.
This does not establish bounds for kernel I/O that never returns; that remains
an explicit qualification limitation, not permission to release a live writer.

`operations.js` preserves ordinary file inode/mode/in-place semantics. Metadata
uses `atomic.js`: private synced scratch, directory-FD-anchored cleanup, stale
content refusal, original mode or native umask on cold creation. Atomic rename
must not bypass native write permission. Scratch has 32-MiB/64-file recovery
ceilings; metadata content has a 16-MiB bound. Cross-device rename fails closed.
Ordinary in-process requests no longer have a helper JSON transport ceiling.

Existing same-repo aliases to regular metadata publish the canonical target,
retaining the alias. Cross-repo/unowned/dangling links, shared-hardlink targets
and metadata leaf symlinks refuse. External ordinary files use no-follow
owned/single-link descriptors checked before truncation (`outside.js`). Broken
Git ownership metadata is never an unfenced fallback. Status counts discovery
and external-guard rejections too; rejected calls do not imply unchanged bytes.

`client.js`/`worker.js` remain a bounded METADATA-ONLY qualification transport.
They refuse ordinary writes before truncation, closing the old unsafe path.
The main registration no longer uses a per-operation helper process.

## Pi shell and native Git integration (source-only)

The `bash` tool and `user_bash` event both use `dracon-warden write-fence`
before starting Bash. The fence covers the current working directory's owning
Git worktree and is inherited by that shell process family, including native
Git commands run in that family. A command outside any Git worktree is refused.
Explicit commands that mutate another worktree or an absolute path are not
sandboxed by this prototype; external editors, unrelated extension tools and
other unmanaged writers also remain unsupported. Do not use those paths for
canonical writes, and do not deploy while they remain outside the qualified
boundary. Explicit Bash timeouts are capped at 3595 seconds; Warden's hard run
bound is 3600 seconds. Cancellation signals the owned process group and escalates
after five seconds; detached descendants may retain the fence until their
inherited descriptor closes.

## Build and reproduce (from this directory)

Linux, a C compiler and Node headers are required. Default headers resolve next
to the actual Node executable; override `NODE_INCLUDE_DIR` if needed. N-API v8
is used. Missing bindings fail loading, never select an unfenced fallback.

```sh
PI_CANONICAL_NATIVE_BINDING=/absolute/qualification/fence.node \
  timeout 35 node build-native.mjs

PI_CANONICAL_NATIVE_BINDING=/absolute/qualification/fence.node \
PI_CANONICAL_TEST_WARDEN=/path/to/qualified/target/debug/dracon-warden \
PI_CANONICAL_TEST_SDK=file:///path/to/pi-coding-agent/dist/index.js \
  timeout 90 node --test test/*.test.mjs
```

Default build output is `build/fence.node`; this work built only an explicitly
selected qualification artifact, not a live-session installation.

## Evidence and real regressions

The previous fast-abort control released I/O immediately. Holding the same write
6.5 seconds past abort exposed the old five-second escalation: the original
full-content assertion FAILED with an empty ordinary file. The failure remains
in `ordinary-long-abort-negative.log/json`, not relabelled as a pass.

The in-process design passes both short and long schedules with the same full
content/inode/mode assertions. Actual Warden exclusion remains held until I/O
settles, while the SAME Pi process publishes another repository before the
blocked write is released. Additional controls cover native OFD reentrancy,
cross-repo refusal, bounded acquisition/cancelled-waiter descriptor cleanup,
unsafe/replaced locks, actual loader schemas/path/legacy edit behavior,
BOM/CRLF/Unicode/diff and ambiguous edits. Readonly and cold umask behavior are
compared with the actual host SDK; the original umask failure is also retained.

Current raw outcomes and unchanged source/SDK/Node/binding/native-peer/header
identities: utilities
`dracon-sync/docs/design/canonical-writer-fence-2026-10-27/pi-inprocess-controls-v3.json`.
Earlier metadata ENOSPC, cancellation and substituted-namespace controls remain;
they are component evidence, not whole-fleet acceptance.

## Still open — deployment remains held

- The original actual-syscall control still fails for an uncooperative raw
  opener. A new Warden-cooperative variant must prove the same helper blocks
  that opener before it can open/write; preserve the original failure as a
  negative control. Do not deploy before the acceptance variant passes.
- Shell/user-bash/native-Git integration is source-only and not yet qualified
  against the original syscall schedule. Explicit cross-worktree/absolute-path
  writes, external editors and detached producers remain outside the fence.
- Already-running operator-session loaded/executed identities (disposable
  loader executions are not that proof), and full workspace assembly gates.
- Whole-host parent death, forced process termination, remaining I/O/deadline
  schedules, ACL/xattr fidelity, directory durability and linked-worktree/device
  behavior. No general crash equivalence or all-producer guarantee is claimed.
- Ordinary large-input qualification; metadata's explicit byte limit remains.
- Unknown/uncooperative writers remain unsupported negative controls, not passes.
- The host SDK's private resolver is revision-bound; a layout/behavior change
  requires fresh qualification even when the export still exists.
