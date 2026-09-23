# O1 workspace leases and deterministic verification

O1 adds the provider-neutral isolation and verification layer that later workflows need before any autonomous writer can be trusted. It adds no provider call, workflow or CLI.

## Workspace leases (`src/platform/workspace/`)

- **One writer, one worktree.** `WorkspaceLeaseManager.acquire({ ownerId, baseRef? })` creates a detached, locked Git worktree at `.fusion/worktrees/<leaseId>` (lock reason `fusion-lease`) from a resolved commit. The owner ID is bound for the lease's lifetime, and `assertOwner`/`release` refuse any other owner. Concurrent acquisitions in one process are serialized and always yield distinct leases.
- **The primary workspace is only read.** Fusion never stashes, resets, cleans, checks out, merges, rebases, pushes, or creates or rewrites branches. Dirty, staged, conflicted and detached primary state stays byte-identical, and a lease starts clean at the base commit. An unborn branch cannot host a lease (`WorkspaceConflict`).
- **Registry first.** `.fusion/leases/<leaseId>.json` is exclusively created (`state: creating`) before `git worktree add`, then made `active`, and later moved to `releasing` and `released`. It records the owner ID, base commit, the owning process ID and timestamps, and no user identity. An interrupted creation is therefore always discoverable.
- **Release is non-destructive by default.** It refuses to remove a lease that holds uncommitted or committed work unless `discardChanges: true` is passed. It is idempotent and removes exactly the owned worktree: links inside it are unlinked first, then the worktree is unlocked and `git worktree remove --force`d by exact path. `git worktree prune` is never run, so unrelated worktrees (including prunable ones) are untouched.
- **Stale leases.** A non-released lease whose owning process is gone, or whose worktree vanished, is stale. `repairStale` repairs one lease at a time, refuses a live owner, and applies the same non-destructive rule.
- **Input safety.** Lease IDs must match `l-<time>-<32 hex>`. Owner IDs are short identifiers. Base refs refuse option-like, range, path, whitespace and control syntax, and are resolved with `--end-of-options`. Records must name exactly their canonical worktree path, so a record pointing at a sibling-prefix directory is rejected as corrupt. A symlink or junction at any Fusion lease location (`.fusion/worktrees`, a lease directory) is a `SecurityViolation`, and nothing is created or removed through it.
- **Git invocation.** Git runs only through `ProcessGitClient`: the native executable found on PATH (never a `.cmd`), an argv array, and `ProcessSupervisor`. Per invocation, no configuration file is changed:
  - inherited `GIT_*` variables are removed
  - hooks point at a nonexistent directory
  - fsmonitor is off
  - prompts are disabled
  - `GIT_OPTIONAL_LOCKS=0` keeps read-only commands from rewriting the primary index

  The user's own settings, such as `core.autocrlf`, still apply to lease checkouts.

## Verification (`src/platform/verification/`)

- A `VerificationPlan` lists explicit steps: ID, absolute native executable, argv array, workspace-relative `cwd`, timeout, and a `mutationPolicy` (`readOnly` | `allowMutation`). Validation runs before any process starts and returns `invalidConfiguration`. It refuses:
  - shell/wrapper executables
  - non-string argv
  - absolute or `..` cwd, or a cwd reached through a junction
  - out-of-range timeouts
  - duplicate IDs
  - a workspace that is not a Git worktree top level
- Each step captures a read-only workspace fingerprint before and after running: HEAD, HEAD ref, the `ls-files --stage` index digest, porcelain status, and content hashes of every dirty or untracked file. A `readOnly` step that changes anything tracked or untracked is a `mutationViolation` (`SecurityViolation`) even on exit 0. An unprovable fingerprint also fails it.
- Statuses stay distinct: `passed`, `failed` (`VerificationFailure`), `timeout`, `cancelled`, `spawnFailure`, `mutationViolation`, `processError`, `evidenceFailure`. A plan stops at the first non-passing step and lists the unexecuted steps in `notRun`.
- A step passes only when Fusion observed exit 0 and its policy held. The engine has no input for model-reported results.
- Output beyond `maxOutputBytes` (default 1 MiB per stream) is drained but not retained, so exit status stays authoritative. Stdout/stderr and pre/post state are stored as redacted artifacts, with file paths as values. `ProcessObserved` and the new `VerificationObserved` events carry bounded evidence only.

## Limitations

- Leases live inside the primary directory, under the self-ignored `.fusion/`. Tools run in the primary that ignore `.gitignore` (for example some test runners' file globs) can see lease copies while leases exist.
- Mutation detection covers what Git tracks or reports as untracked. Writes into ignored paths (build output, caches) are not detected. Files over 64 MiB are fingerprinted by size and modification time.
- Liveness is a PID probe. A reused PID makes a dead owner look alive, so such a lease is never auto-repaired; this errs on the safe side. One corrupt registry record makes stale scanning fail closed until it is inspected.
- Concurrency is serialized within one Fusion process. Across processes, exclusive record creation and Git's own locks apply, but there is no global lease lock.
